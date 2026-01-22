// src/routes/students.ts
import { Router, Request, Response, NextFunction } from "express";
import { withTenantClient } from "../lib/db";

const router = Router();

/**
 * Helper to get tenant from app context
 * (set once in server.ts)
 */
function getTenant(req: Request): string {
    const tenant = req.app.locals.tenantId;
    if (!tenant) {
        throw new Error("Tenant not initialized on app.locals");
    }
    return tenant;
}

// --------------------
// List users
// --------------------
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const tenant = getTenant(req);

        const users = await withTenantClient(tenant, async (client) => {
            const { rows } = await client.query(
                "SELECT * FROM user"
            );
            return rows;
        });

        res.json(users);
    } catch (err) {
        next(err);
    }
});

export default router;
