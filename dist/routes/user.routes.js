"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/students.ts
const express_1 = require("express");
const db_1 = require("../lib/db");
const router = (0, express_1.Router)();
/**
 * Helper to get tenant from app context
 * (set once in server.ts)
 */
function getTenant(req) {
    const tenant = req.app.locals.tenantId;
    if (!tenant) {
        throw new Error("Tenant not initialized on app.locals");
    }
    return tenant;
}
// --------------------
// List users
// --------------------
router.get("/", async (req, res, next) => {
    try {
        const tenant = getTenant(req);
        const users = await (0, db_1.withTenantClient)(tenant, async (client) => {
            const { rows } = await client.query("SELECT * FROM user");
            return rows;
        });
        res.json(users);
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;
