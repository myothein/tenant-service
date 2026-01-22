// src/lib/db.ts
import pg from "pg";
import { Logger } from "../utils/logger";

/**
 * ----------------------------------------
 * Types
 * ----------------------------------------
 */
export interface DBConfig {
    databaseUrlTemplate: string;
    maxConnections: number;
}

/**
 * ----------------------------------------
 * Configuration (loaded at runtime)
 * ----------------------------------------
 */
export const dbConfig: DBConfig = {
    databaseUrlTemplate:
        process.env.TENANT_DATABASE_URL_TEMPLATE ??
        "postgresql://admin:1234@localhost:5432/{tenant}?schema=public",

    maxConnections: Number(process.env.DB_MAX_CONNECTIONS ?? 10),
};

/**
 * ----------------------------------------
 * Internal pool registry
 * ----------------------------------------
 */
const tenantPools = new Map<string, pg.Pool>();

/**
 * ----------------------------------------
 * Guards
 * ----------------------------------------
 */
function assertTenant(tenantName?: string): asserts tenantName is string {
    if (!tenantName || tenantName.trim() === "") {
        throw new Error("[DB] tenantName is required but was undefined or empty");
    }
}

/**
 * ----------------------------------------
 * Pool factory (one pool per tenant)
 * ----------------------------------------
 */
export function getTenantPool(tenantName: string): pg.Pool {
    assertTenant(tenantName);

    const cached = tenantPools.get(tenantName);
    if (cached) {
        return cached;
    }

    const databaseUrl = dbConfig.databaseUrlTemplate.replace("{tenant}", tenantName);
    const url = new URL(databaseUrl);

    const pool = new pg.Pool({
        host: url.hostname,
        port: Number(url.port || 5432),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.replace("/", ""),
        max: dbConfig.maxConnections,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
    });

    pool.on("error", (err) => {
        Logger.error(`[PG] Pool error for tenant ${tenantName}`, err);
    });

    tenantPools.set(tenantName, pool);

    Logger.info(`[PG] Tenant pool created for: ${tenantName}`);
    return pool;
}

/**
 * ----------------------------------------
 * Client helper
 * ----------------------------------------
 */
export async function withTenantClient<T>(
    tenantName: string,
    fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
    const pool = getTenantPool(tenantName);
    const client = await pool.connect();

    try {
        return await fn(client);
    } finally {
        client.release();
    }
}

/**
 * ----------------------------------------
 * Graceful shutdown
 * ----------------------------------------
 */
export async function closeAllTenantPools(): Promise<void> {
    for (const [tenant, pool] of tenantPools.entries()) {
        try {
            await pool.end();
            Logger.info(`[PG] Pool closed for tenant: ${tenant}`);
        } catch (err) {
            Logger.error(`[PG] Failed to close pool for tenant: ${tenant}`, err);
        }
    }

    tenantPools.clear();
}
