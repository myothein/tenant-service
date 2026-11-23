import { withTenantClient } from '../lib/db';
import { tenantHandler } from '../utils/tenant-handler';

export const fetchPendingEvents = tenantHandler(async (req, res, next) => {
    const limit = Number(req.query.limit ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        res.status(400).json({ error: 'Invalid event limit' }); return;
    }
    try {
        const data = await withTenantClient(req.tenantId, async client => {
            const result = await client.query(
                'SELECT id,tenant_code,agent_id,aggregate_type,aggregate_id,event_type,payload,' +
                'created_at,occurred_at,event_version,headers FROM local_events ' +
                "WHERE tenant_code = $1 AND status = 'pending' AND sent = 0 " +
                'ORDER BY created_at ASC LIMIT $2',
                [req.tenantId, limit]
            );
            return result.rows;
        });
        res.json({ data });
    } catch (error) { next(error); }
});

/** A retry after a lost HTTP response must not fail or reapply the event. */
export const markEventSent = tenantHandler(async (req, res, next) => {
    const id = req.params.id;
    if (typeof id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        res.status(400).json({ success: false, code: 'INVALID_EVENT_ID' }); return;
    }
    try {
        const result = await withTenantClient(req.tenantId, async client => {
            const updated = await client.query(
                "UPDATE local_events SET status = 'sent', sent = 1 " +
                "WHERE id = $1 AND tenant_code = $2 AND status = 'pending' AND sent = 0 " +
                'RETURNING id, tenant_code, status, sent',
                [id, req.tenantId]
            );
            if (updated.rows[0]) return { event: updated.rows[0], replayed: false };

            // A separate SQL statement observes the committed state after
            // concurrent UPDATE row-lock waits under PostgreSQL READ COMMITTED.
            // Never turn an unrelated tenant's event into a successful response.
            const acknowledged = await client.query(
                "SELECT id, tenant_code, status, sent FROM local_events " +
                "WHERE id = $1 AND tenant_code = $2 AND status = 'sent' AND sent = 1",
                [id, req.tenantId]
            );
            if (acknowledged.rows[0]) {
                return { event: acknowledged.rows[0], replayed: true };
            }
            return null;
        });
        if (!result) {
            res.status(404).json({ success: false, code: 'EVENT_NOT_FOUND' }); return;
        }
        res.setHeader('Cache-Control', 'no-store');
        if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
        res.json({
            message: 'Event marked as sent',
            event: result.event,
            replayed: result.replayed
        });
    } catch (error) { next(error); }
});
