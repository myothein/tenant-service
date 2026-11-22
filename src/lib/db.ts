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
    const connectionString = config.databaseUrlTemplate.replace('{tenant}', tenantName);
    const parsed = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        throw new Error('Configured database URL must be PostgreSQL');
    }
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

export async function withTenantClient<T>(
    tenantName: string,
    fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
    const client = await getTenantPool(tenantName).connect();
    try {
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
