import { timingSafeEqual } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export type ApiRole = 'admin' | 'agent';

type OidcConfig = { issuer: string; audience: string; jwksUrl: string; requiredRole: string };
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function safeEndpoint(value: string, label: string): URL {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error(label + ' invalid'); }
    if (url.username || url.password || url.search || url.hash ||
        !['http:', 'https:'].includes(url.protocol) ||
        (url.protocol === 'http:' &&
            (process.env.NODE_ENV === 'production' ||
                !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new Error(label + ' requires HTTPS outside loopback');
    }
    return url;
}

/** Configuration is trusted from deployment env, never derived from a token header. */
function readOidcConfig(): OidcConfig {
    const issuer = process.env.TENANT_OIDC_ISSUER;
    const jwksUrl = process.env.TENANT_OIDC_JWKS_URL;
    const audience = process.env.TENANT_OIDC_AUDIENCE;
    const requiredRole = process.env.TENANT_OIDC_REQUIRED_ROLE || 'TENANT_ADMIN';
    if (!issuer || !jwksUrl || !audience || !/^[A-Za-z0-9_.:-]{2,80}$/.test(audience) ||
        !/^[A-Za-z0-9_-]{2,64}$/.test(requiredRole)) {
        throw new Error('OIDC authentication not configured');
    }
    const iss = safeEndpoint(issuer, 'OIDC_ISSUER');
    const keys = safeEndpoint(jwksUrl, 'OIDC_JWKS_URL');
    if (iss.origin !== keys.origin || iss.pathname === '/' || keys.pathname === '/') {
        throw new Error('OIDC issuer and public JWKS URL must share an origin');
    }
    return { issuer: iss.href.replace(/\/$/, ''), jwksUrl: keys.href,
        audience, requiredRole };
}

function requireMachineKey(role: 'agent' | 'admin', req: Request, res: Response, next: NextFunction) {
    // Admin shared API keys are allowed ONLY in non-production explicit QA mode.
    if (role === 'admin' && (!['test','development'].includes(process.env.NODE_ENV || '') ||
        process.env.TENANT_ALLOW_DEV_API_KEY !== 'true')) {
        return res.status(503).json({success:false,code:'AUTH_NOT_CONFIGURED'});
    }
    const key = process.env[role === 'admin' ? 'TENANT_ADMIN_API_KEY' : 'TENANT_AGENT_API_KEY'];
    if (!key || Buffer.byteLength(key, 'utf8') < 32) {
        return res.status(503).json({ success:false, code:'AUTH_NOT_CONFIGURED' });
    }
    // Fail closed on accidental cross-role credential reuse. A compromised
    // administrator secret must never also authorize durable agent outbox access.
    const otherKey = process.env[role === 'admin' ? 'TENANT_AGENT_API_KEY' : 'TENANT_ADMIN_API_KEY'];
    if (otherKey) {
        const otherBytes = Buffer.from(otherKey, 'utf8');
        const keyBytes = Buffer.from(key, 'utf8');
        if (otherBytes.length === keyBytes.length && timingSafeEqual(otherBytes, keyBytes)) {
            return res.status(503).json({ success:false, code:'AUTH_NOT_CONFIGURED' });
        }
    }
    const authorization = req.get('authorization') || '';
    const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const expectedBytes = Buffer.from(key,'utf8');
    const suppliedBytes = Buffer.from(provided,'utf8');
    if (suppliedBytes.length !== expectedBytes.length ||
        !timingSafeEqual(suppliedBytes,expectedBytes)) {
        return res.status(401).json({ success:false,code:'UNAUTHORIZED' });
    }
    next();
}

/** Signed OIDC access token must prove issuer, audience, expiration, role and fixed tenant. */
async function requireOidcAdmin(req: Request, res: Response, next: NextFunction) {
    let config: OidcConfig;
    try { config = readOidcConfig(); }
    catch {
        return res.status(503).json({ success:false,code:'AUTH_NOT_CONFIGURED' });
    }
    const authorization=req.get('authorization') || '';
    const token=authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!token || token.length > 16_384) {
        return res.status(401).json({ success:false,code:'UNAUTHORIZED' });
    }
    try {
        let jwks=jwksCache.get(config.jwksUrl);
        if (!jwks) {
            jwks=createRemoteJWKSet(new URL(config.jwksUrl), {
                timeoutDuration:3000, cooldownDuration:30_000, cacheMaxAge:5*60_000
            });
            jwksCache.set(config.jwksUrl,jwks);
        }
        const {payload}=await jwtVerify(token,jwks,{
            issuer:config.issuer,
            audience:config.audience,
            algorithms:['RS256'],
            clockTolerance:5,
            maxTokenAge:'1h'
        });
        if (typeof payload.sub !== 'string' || payload.sub.length === 0 ||
            typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
            return res.status(401).json({success:false,code:'UNAUTHORIZED'});
        }
        const tenantId=req.app.locals.tenantId;
        if (typeof tenantId !== 'string' || payload.tenant_id !== tenantId) {
            return res.status(403).json({success:false,code:'TENANT_FORBIDDEN'});
        }
        // Keycloak realm roles are supported. Roles are trusted ONLY after signature verification.
        const realm=payload.realm_access;
        const realmRoles = realm && typeof realm === 'object' && !Array.isArray(realm) &&
            'roles' in realm ? (realm as {roles:unknown}).roles : undefined;
        const roles = Array.isArray(realmRoles) ? realmRoles : payload.roles;
        if (!Array.isArray(roles) || !roles.includes(config.requiredRole)) {
            return res.status(403).json({success:false,code:'ROLE_FORBIDDEN'});
        }
        res.locals.subject=payload.sub;
        res.locals.authorizedTenantId=tenantId;
        next();
    } catch {
        return res.status(401).json({success:false,code:'UNAUTHORIZED'});
    }
}

export function requireApiRole(role: ApiRole) {
    return (req: Request,res: Response,next: NextFunction) => {
        res.setHeader('Cache-Control','no-store');
        if (role === 'agent') return requireMachineKey('agent',req,res,next);
        // OIDC is the secure default. Legacy mode is explicit and permanently
        // forbidden for NODE_ENV=production.
        if (process.env.TENANT_ADMIN_AUTH_MODE === 'legacy') {
            return requireMachineKey('admin',req,res,next);
        }
        if (process.env.TENANT_ADMIN_AUTH_MODE &&
            process.env.TENANT_ADMIN_AUTH_MODE !== 'oidc') {
            return res.status(503).json({success:false,code:'AUTH_NOT_CONFIGURED'});
        }
        void requireOidcAdmin(req,res,next).catch(() =>
            res.status(401).json({success:false,code:'UNAUTHORIZED'}));
    };
}
