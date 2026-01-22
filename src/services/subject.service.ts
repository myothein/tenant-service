// apps/tenant-service/src/services/subject.service.ts
import { withTenantClient } from "../lib/db";
import { tenantHandler } from "../utils/tenant-handler";

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
   Create Subject
====================== */
export const createSubject = tenantHandler(async (req, res, next) => {
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

            const newSubject = rows[0];

            // Insert local_event
            await client.query(
                `
                    INSERT INTO local_events (
                        id, tenant_code, agent_id, aggregate_type, aggregate_id,
                        event_type, payload, created_at, occurred_at, sent,
                        status, retry_count, event_version, headers
                    )
                    VALUES (
                        gen_random_uuid(), $1, $2, 'Subject', $3,
                        'subject.created', $4, NOW(), NOW(), 0,
                        'pending', 0, 1, '{}'
                    )
                `,
                [
                    req.tenantId,
                    "tenant-agent-1",
                    newSubject.id,
                    JSON.stringify(newSubject),
                ]
            );

            return newSubject;
        });

        res.status(201).json(subject);
    } catch (err: any) {
        if (err.code === "23505") {
            res.status(409).json({ error: "Subject already exists for this tenant" });
            return;
        }
        next(err);
    }
});

/* ======================
   Update Subject
====================== */
export const updateSubject = tenantHandler(async (req, res, next) => {
    try {
        const { id } = req.params;
        const { name, tenant_code } = req.body;

        if (!requireName(name, res) || !requireTenantCode(tenant_code, res)) return;

        const subject = await withTenantClient(req.tenantId, async (client) => {
            const { rows } = await client.query(
                `
                    UPDATE subject
                    SET name = $1, updated_at = NOW()
                    WHERE id = $2 AND tenant_code = $3 AND deleted_at IS NULL
                    RETURNING *
                `,
                [name, id, tenant_code]
            );

            const updatedSubject = rows[0];
            if (!updatedSubject) return null;

            // Insert local_event
            await client.query(
                `
                    INSERT INTO local_events (
                        id, tenant_id, agent_id, aggregate_type, aggregate_id,
                        event_type, payload, created_at, occurred_at, sent,
                        status, retry_count, event_version, headers
                    )
                    VALUES (
                        gen_random_uuid(), $1, $2, 'Subject', $3,
                        'subject.updated', $4, NOW(), NOW(), 0,
                        'pending', 0, 1, '{}'
                    )
                `,
                [
                    req.tenantId,
                    "tenant-agent-1",
                    updatedSubject.id,
                    JSON.stringify(updatedSubject),
                ]
            );

            return updatedSubject;
        });

        if (!subject) {
            res.status(404).json({ error: "Subject not found" });
            return;
        }

        res.json(subject);
    } catch (err: any) {
        if (err.code === "23505") {
            res.status(409).json({ error: "Subject already exists for this tenant" });
            return;
        }
        next(err);
    }
});

/* ======================
   Soft Delete Subject
====================== */
export const deleteSubject = tenantHandler(async (req, res, next) => {
    try {
        const { id } = req.params;
        const { tenant_code } = req.body;

        if (!requireTenantCode(tenant_code, res)) return;

        const subject = await withTenantClient(req.tenantId, async (client) => {
            const { rows } = await client.query(
                `
                    UPDATE subject
                    SET deleted_at = NOW()
                    WHERE id = $1 AND tenant_code = $2 AND deleted_at IS NULL
                    RETURNING *
                `,
                [id, tenant_code]
            );

            const deletedSubject = rows[0];
            if (!deletedSubject) return null;

            // Insert local_event
            await client.query(
                `
                    INSERT INTO local_events (
                        id, tenant_id, agent_id, aggregate_type, aggregate_id,
                        event_type, payload, created_at, occurred_at, sent,
                        status, retry_count, event_version, headers
                    )
                    VALUES (
                        gen_random_uuid(), $1, $2, 'Subject', $3,
                        'subject.deleted', $4, NOW(), NOW(), 0,
                        'pending', 0, 1, '{}'
                    )
                `,
                [
                    req.tenantId,
                    "tenant-agent-1",
                    deletedSubject.id,
                    JSON.stringify(deletedSubject),
                ]
            );

            return deletedSubject;
        });

        if (!subject) {
            res.status(404).json({ error: "Subject not found" });
            return;
        }

        res.json(subject);
    } catch (err) {
        next(err);
    }
});
