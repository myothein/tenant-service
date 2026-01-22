// apps/tenant-service/src/services/local-event.service.ts
import { withTenantClient } from "../lib/db";
import { tenantHandler } from "../utils/tenant-handler";

/* ======================
   Create local event
====================== */
export const createLocalEvent = tenantHandler(
    async (req, res, next) => {
        try {
            const { aggregate_type, aggregate_id, event_type, payload } = req.body;

            if (!aggregate_type || typeof aggregate_type !== "string") {
                res.status(400).json({ error: "aggregate_type is required" });
                return;
            }

            if (!aggregate_id) {
                res.status(400).json({ error: "aggregate_id is required" });
                return;
            }

            if (!event_type || typeof event_type !== "string") {
                res.status(400).json({ error: "event_type is required" });
                return;
            }

            const event = await withTenantClient(req.tenantId, async (client) => {
                const { rows } = await client.query(
                    `
                        INSERT INTO local_events (
                            id,
                            tenant_id,
                            agent_id,
                            aggregate_type,
                            aggregate_id,
                            event_type,
                            payload,
                            created_at,
                            occurred_at,
                            sent,
                            status,
                            retry_count,
                            event_version,
                            headers
                        )
                        VALUES (
                            gen_random_uuid(),
                            $1, $2, $3, $4, $5, $6,
                            NOW(), NOW(), 0, 'pending', 0, 1, '{}'
                        )
                        RETURNING *
                    `,
                    [
                        req.tenantId,
                        "tenant-agent-1",
                        aggregate_type,
                        String(aggregate_id),
                        event_type,
                        JSON.stringify(payload),
                    ]
                );
                return rows[0];
            });

            res.status(201).json(event);
        } catch (err) {
            next(err);
        }
    }
);
/* ======================
   Fetch pending events
====================== */
export async function fetchPendingEvents(req: any, res: any) {
    const tenantId = req.tenantId;
    const limit = Number(req.query.limit ?? 50);

    const events = await withTenantClient(tenantId, async (client) => {
        const { rows } = await client.query(
            `
            SELECT *
            FROM local_events
            WHERE tenant_code = $1
              AND status = 'pending'
            ORDER BY created_at ASC
            LIMIT $2
            `,
            [tenantId, limit]
        );
        return rows;
    });

    res.json({ data: events });
}

/* ======================
   Mark an event as sent
====================== */
export async function markEventSent(req: any, res: any) {
    const tenantId = req.tenantId;
    const { id } = req.params;

    const event = await withTenantClient(tenantId, async (client) => {
        const { rows } = await client.query(
            `
                UPDATE local_events
                SET
                    status = 'sent',
                    sent = 1
                WHERE id = $1
                  AND tenant_code = $2
                  AND status = 'pending'
                    RETURNING *
            `,
            [id, tenantId]
        );

        return rows[0] ?? null;
    });

    if (!event) {
        return res.status(404).json({
            error: "Event not found or already sent"
        });
    }

    res.json({
        message: "Event marked as sent",
        event
    });
}
