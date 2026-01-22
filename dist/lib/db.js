"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbConfig = void 0;
exports.getTenantPool = getTenantPool;
exports.withTenantClient = withTenantClient;
exports.closeAllTenantPools = closeAllTenantPools;
// src/lib/db.ts
const pg_1 = __importDefault(require("pg"));
const logger_1 = require("../utils/logger");
/**
 * ----------------------------------------
 * Configuration (loaded at runtime)
 * ----------------------------------------
 */
exports.dbConfig = {
    databaseUrlTemplate: process.env.TENANT_DATABASE_URL_TEMPLATE ??
        "postgresql://admin:1234@localhost:5432/{tenant}?schema=public",
    maxConnections: Number(process.env.DB_MAX_CONNECTIONS ?? 10),
};
/**
 * ----------------------------------------
 * Internal pool registry
 * ----------------------------------------
 */
const tenantPools = new Map();
/**
 * ----------------------------------------
 * Guards
 * ----------------------------------------
 */
function assertTenant(tenantName) {
    if (!tenantName || tenantName.trim() === "") {
        throw new Error("[DB] tenantName is required but was undefined or empty");
    }
}
/**
 * ----------------------------------------
 * Pool factory (one pool per tenant)
 * ----------------------------------------
 */
function getTenantPool(tenantName) {
    assertTenant(tenantName);
    const cached = tenantPools.get(tenantName);
    if (cached) {
        return cached;
    }
    const databaseUrl = exports.dbConfig.databaseUrlTemplate.replace("{tenant}", tenantName);
    const url = new URL(databaseUrl);
    const pool = new pg_1.default.Pool({
        host: url.hostname,
        port: Number(url.port || 5432),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.replace("/", ""),
        max: exports.dbConfig.maxConnections,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
    });
    pool.on("error", (err) => {
        logger_1.Logger.error(`[PG] Pool error for tenant ${tenantName}`, err);
    });
    tenantPools.set(tenantName, pool);
    logger_1.Logger.info(`[PG] Tenant pool created for: ${tenantName}`);
    return pool;
}
/**
 * ----------------------------------------
 * Client helper
 * ----------------------------------------
 */
async function withTenantClient(tenantName, fn) {
    const pool = getTenantPool(tenantName);
    const client = await pool.connect();
    try {
        return await fn(client);
    }
    finally {
        client.release();
    }
}
/**
 * ----------------------------------------
 * Graceful shutdown
 * ----------------------------------------
 */
async function closeAllTenantPools() {
    for (const [tenant, pool] of tenantPools.entries()) {
        try {
            await pool.end();
            logger_1.Logger.info(`[PG] Pool closed for tenant: ${tenant}`);
        }
        catch (err) {
            logger_1.Logger.error(`[PG] Failed to close pool for tenant: ${tenant}`, err);
        }
    }
    tenantPools.clear();
}
