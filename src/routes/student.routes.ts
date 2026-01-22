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

/* ======================
   List students (with pagination)
====================== */
router.get(
    "/",
    tenantHandler(async (req, res, next) => {
        try {
            const page = Number(req.query.page ?? 1);
            const limit = Number(req.query.limit ?? 20);
            const offset = (page - 1) * limit;

            const students = await withTenantClient(req.tenantId, async (client) => {
                const { rows } = await client.query(
                    `
                    SELECT *
                    FROM students
                    WHERE deleted_at IS NULL
                    ORDER BY id ASC
                    LIMIT $1 OFFSET $2
                    `,
                    [limit, offset]
                );
                return rows;
            });

            res.json({
                page,
                limit,
                data: students,
            });
        } catch (err) {
            next(err);
        }
    })
);

/* ======================
   Add student
====================== */
router.post(
    "/",
    tenantHandler(async (req, res, next) => {
        try {
            const { name } = req.body;
            if (!requireName(name, res)) return;

            const student = await withTenantClient(req.tenantId, async (client) => {
                const { rows } = await client.query(
                    `
                    INSERT INTO students (name)
                    VALUES ($1)
                    RETURNING *
                    `,
                    [name]
                );
                return rows[0];
            });

            res.status(201).json(student);
        } catch (err) {
            next(err);
        }
    })
);

/* ======================
   Update student
====================== */
router.put(
    "/:id",
    tenantHandler(async (req, res, next) => {
        try {
            const { id } = req.params;
            const { name } = req.body;

            if (!requireName(name, res)) return;

            const student = await withTenantClient(req.tenantId, async (client) => {
                const { rows } = await client.query(
                    `
                    UPDATE students
                    SET name = $1,
                        updated_at = NOW()
                    WHERE id = $2
                      AND deleted_at IS NULL
                    RETURNING *
                    `,
                    [name, id]
                );
                return rows[0];
            });

            if (!student) {
                res.status(404).json({ error: "Student not found" });
                return;
            }

            res.json(student);
        } catch (err) {
            next(err);
        }
    })
);

/* ======================
   Soft delete student
====================== */
router.delete(
    "/:id",
    tenantHandler(async (req, res, next) => {
        try {
            const { id } = req.params;

            const student = await withTenantClient(req.tenantId, async (client) => {
                const { rows } = await client.query(
                    `
                    UPDATE students
                    SET deleted_at = NOW()
                    WHERE id = $1
                      AND deleted_at IS NULL
                    RETURNING *
                    `,
                    [id]
                );
                return rows[0];
            });

            if (!student) {
                res.status(404).json({ error: "Student not found" });
                return;
            }

            res.json(student);
        } catch (err) {
            next(err);
        }
    })
);

export default router;
