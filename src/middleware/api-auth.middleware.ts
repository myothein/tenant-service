import { timingSafeEqual } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';

export type ApiRole = 'admin' | 'agent';

/**
 * Temporary service credential gate until OIDC/mTLS and scoped RBAC are implemented.
 * Do not deploy as a substitute for user authentication or final production security.
 */
export function requireApiRole(role: ApiRole) {
    return (req: Request, res: Response, next: NextFunction) => {
        res.setHeader('Cache-Control', 'no-store');
        const expected = process.env[role === 'admin' ? 'TENANT_ADMIN_API_KEY' : 'TENANT_AGENT_API_KEY'];
        if (!expected || Buffer.byteLength(expected, 'utf8') < 32) {
            return res.status(503).json({
                success: false,
                code: 'AUTH_NOT_CONFIGURED',
                message: 'Protected API unavailable'
            });
        }
        const header = req.get('authorization') || '';
        const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
        const actualBytes = Buffer.from(presented, 'utf8');
        const expectedBytes = Buffer.from(expected, 'utf8');
        if (actualBytes.length !== expectedBytes.length ||
            !timingSafeEqual(actualBytes, expectedBytes)) {
            return res.status(401).json({
                success: false, code: 'UNAUTHORIZED', message: 'Unauthorized'
            });
        }
        next();
    };
}
