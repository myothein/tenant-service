// apps/tenant-service/src/routes/subject.routes.ts
import { Router } from "express";
import { createSubject, updateSubject, deleteSubject } from "../services/subject.service";
import { withTenantClient } from "../lib/db";
import { tenantHandler } from "../utils/tenant-handler";

const router = Router();

/* ======================
   List subjects (pagination)
====================== */
router.get(
    "/",
    tenantHandler(async (req, res, next) => {
        try {
            const page = Number(req.query.page ?? 1);
            const limit = Number(req.query.limit ?? 20);
            const offset = (page - 1) * limit;

            const subjects = await withTenantClient(req.tenantId, async (client) => {
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

            res.json({ page, limit, data: subjects });
        } catch (err) {
            next(err);
        }
    })
);

/* ======================
   Create Subject
====================== */
router.post("/", createSubject);

/* ======================
   Update Subject
====================== */
router.put("/:id", updateSubject);

/* ======================
   Soft Delete Subject
====================== */
router.delete("/:id", deleteSubject);

export default router;
