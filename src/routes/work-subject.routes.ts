import { Router } from "express";
import { withTenantClient } from "../lib/db";
import { tenantHandler } from "../utils/tenant-handler";

const router = Router();

/* ======================
   Helpers
====================== */
function requireName(name: unknown, res: any): name is string {
    if (!name || typeof name !== "string") {
        res.status(400).json({ error: "Name is required" });
        return false;
    }
    return true;
}

function requireTenantCode(code: unknown, res: any): code is string {
    if (!code || typeof code !== "string") {
        res.status(400).json({ error: "tenant_code is required" });
        return false;
    }
    return true;
}

/* ======================
   List subject (pagination)
====================== */
router.get(
    "/",
    tenantHandler(async (req, res, next) => {
        try {
            const page = Number(req.query.page ?? 1);
            const limit = Number(req.query.limit ?? 20);
            const offset = (page - 1) * limit;

            const subject = await withTenantClient(req.tenantId, async (client) => {
                const { rows } = await client.query(
                    `
                        SELECT *
                        FROM subject
                        WHERE deleted_at IS NULL
                          AND tenant_code = $1
                        ORDER BY id ASC
                            LIMIT $2 OFFSET $3
                    `,
                    [req.tenantId, limit, offset]
                );
                return rows;
            });

            res.json({ page, limit, data: subject });
        } catch (err) {
            next(err);
        }
    })
);

/* ======================
   Add subject
====================== */
router.post(
    "/",
    tenantHandler(async (req, res, next) => {
        try {
            const { name, tenant_code } = req.body;
            if (!requireName(name, res) || !requireTenantCode(tenant_code, res)) return;

            const subject = await withTenantClient(req.tenantId, async (client) => {
                const { rows } = await client.query(
                    `
                        INSERT INTO subject (name, tenant_code, created_at, updated_at)
                        VALUES ($1, $2, NOW(), NOW())
                            RETURNING *
                    `,
                    [name, tenant_code]
                );
                return rows[0];
            });

            res.status(201).json(subject);
        } catch (err: any) {
            if (err.code === "23505") {
                res.status(409).json({ error: "Subject already exists for this school" });
                return;
            }
            next(err);
        }
    })
);

/* ======================
   Update subject
====================== */
router.put(
    "/:id",
    tenantHandler(async (req, res, next) => {
        try {
            const { id } = req.params;
            const { name, tenant_code } = req.body;

            if (!requireName(name, res) || !requireTenantCode(tenant_code, res)) return;

            const subject = await withTenantClient(req.tenantId, async (client) => {
                const { rows } = await client.query(
                    `
                        UPDATE subject
                        SET name = $1, updated_at = NOW()
                        WHERE id = $2
                          AND tenant_code = $3
                          AND deleted_at IS NULL
                            RETURNING *
                    `,
                    [name, id, tenant_code]
                );
                return rows[0];
            });

            if (!subject) {
                res.status(404).json({ error: "Subject not found" });
                return;
            }

            res.json(subject);
        } catch (err: any) {
            if (err.code === "23505") {
                res.status(409).json({ error: "Subject already exists for this school" });
                return;
            }
            next(err);
        }
    })
);

/* ======================
   Soft delete subject
====================== */
router.delete(
    "/:id",
    tenantHandler(async (req, res, next) => {
        try {
            const { id } = req.params;
            const { tenant_code } = req.body;

            if (!requireTenantCode(tenant_code, res)) return;

            const subject = await withTenantClient(req.tenantId, async (client) => {
                const { rows } = await client.query(
                    `
                        UPDATE subject
                        SET deleted_at = NOW()
                        WHERE id = $1
                          AND tenant_code = $2
                          AND deleted_at IS NULL
                        RETURNING *
                    `,
                    [id, tenant_code]
                );
                return rows[0];
            });

            if (!subject) {
                res.status(404).json({ error: "Subject not found" });
                return;
            }

            res.json(subject);
        } catch (err) {
            next(err);
        }
    })
);

export default router;
