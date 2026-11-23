import pg from 'pg';
import { Logger } from '../utils/logger';

export interface DBConfig {
    databaseUrlTemplate: string;
    maxConnections: number;
}

const tenantPools = new Map<string, pg.Pool>();

function assertTenant(tenantName: string): void {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenantName)) {
        throw new Error('Invalid configured tenant code');
    }
}

/**
 * A deployment may connect to ONE preconfigured tenant DB, never a URL chosen by
 * request headers, token claims or user-controlled PostgreSQL connection options.
 */
export function resolveTenantDatabaseUrl(template: string, tenantName: string): string {
    assertTenant(tenantName);
    if (typeof template !== 'string' ||
        template.split('{tenant}').length !== 2) {
        throw new Error('Invalid tenant database URL template');
    }
    const connectionString=template.replace('{tenant}',tenantName);
    let parsed: URL;
    try {parsed=new URL(connectionString);}
    catch {throw new Error('Invalid tenant database connection URL');}
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
        !parsed.hostname || !parsed.username || !parsed.password || parsed.hash ||
        decodeURIComponent(parsed.pathname.slice(1)) !== tenantName ||
        parsed.pathname.includes('/',1)) {
        throw new Error('Tenant DB URL must target the fixed tenant database');
    }
    const allowed=new Set(['sslmode']);
    for(const key of parsed.searchParams.keys()){
        if(!allowed.has(key) || parsed.searchParams.getAll(key).length!==1){
            throw new Error('Unsafe PostgreSQL connection URL parameters');
        }
    }
    const sslmode=parsed.searchParams.get('sslmode');
    const local=['localhost','127.0.0.1','[::1]'].includes(parsed.hostname);
    if (!local && sslmode!=='verify-full') {
        throw new Error('Remote PostgreSQL requires verified TLS');
    }
    if (process.env.NODE_ENV==='production') {
        const expected=process.env.TENANT_DB_EXPECTED_ROLE;
        if(!expected || !/^[a-z_][a-z0-9_]{0,62}$/.test(expected) ||
            decodeURIComponent(parsed.username)!==expected ||
            ['postgres','root','admin'].includes(expected)) {
            throw new Error('Production tenant DB role is not explicitly validated');
        }
    }
    return connectionString;
}

function readDbConfig(): DBConfig {
    const template = process.env.TENANT_DATABASE_URL_TEMPLATE;
    if (!template || !template.includes('{tenant}')) {
        throw new Error('TENANT_DATABASE_URL_TEMPLATE must be configured with {tenant}');
    }
    const maxConnections = Number(process.env.DB_MAX_CONNECTIONS || 10);
    if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 50) {
        throw new Error('Invalid DB_MAX_CONNECTIONS');
    }
    return { databaseUrlTemplate: template, maxConnections };
}

export function getTenantPool(tenantName: string): pg.Pool {
    assertTenant(tenantName);
    const cached = tenantPools.get(tenantName);
    if (cached) return cached;
    const config = readDbConfig();
    const connectionString = resolveTenantDatabaseUrl(config.databaseUrlTemplate, tenantName);
    const pool = new pg.Pool({
        connectionString, max: config.maxConnections,
        connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000
    });
    pool.on('error', (error: Error) => {
        // Do not print connection strings, PostgreSQL error details or secrets.
        Logger.error('[PG] Idle tenant pool error: ' + error.name);
    });
    tenantPools.set(tenantName, pool);
    return pool;
}

/** Reject privileged DBA credentials when running tenant-service in production. */
export async function assertRuntimeDbRole(client: Pick<pg.PoolClient, 'query'>): Promise<void> {
    if (process.env.NODE_ENV !== 'production') return;
    const expected=process.env.TENANT_DB_EXPECTED_ROLE;
    if(!expected || !/^[a-z_][a-z0-9_]{0,62}$/.test(expected)){
        throw new Error('Production tenant DB role not configured');
    }
    const result=await client.query<{
        role_name:string;rolsuper:boolean;rolcreatedb:boolean;
        rolcreaterole:boolean;rolreplication:boolean;rolbypassrls:boolean;
    }>(`SELECT current_user AS role_name,
        rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
        FROM pg_roles WHERE rolname=current_user`);
    const role=result.rows[0];
    if (!role || role.role_name !== expected || role.rolsuper || role.rolcreatedb ||
        role.rolcreaterole || role.rolreplication || role.rolbypassrls) {
        throw new Error('Tenant database login has unsafe privileges');
    }
}

export async function withTenantClient<T>(
    tenantName: string,
    fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
    const client = await getTenantPool(tenantName).connect();
    try {
        await assertRuntimeDbRole(client);
        return await fn(client);
    } finally {
        client.release();
    }
}

/** Commit domain data and the matching outbox event atomically. */
export async function runInTransaction<T>(
    client: pg.PoolClient,
    action: () => Promise<T>
): Promise<T> {
    await client.query('BEGIN');
    try {
        const value = await action();
        await client.query('COMMIT');
        return value;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            Logger.error('[PG] Transaction rollback failed');
        }
        throw error;
    }
}

export async function closeAllTenantPools(): Promise<void> {
    for (const [tenant, pool] of tenantPools) {
        try {
            await pool.end();
        } catch {
            Logger.error('[PG] Failed to close pool for tenant ' + tenant);
        }
    }
    tenantPools.clear();
}
