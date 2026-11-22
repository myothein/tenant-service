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

export const markEventSent = tenantHandler(async (req, res, next) => {
    const id = req.params.id;
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
        res.status(400).json({ error: 'Invalid event id' }); return;
    }
    try {
        const event = await withTenantClient(req.tenantId, async client => {
            const result = await client.query(
                'UPDATE local_events SET status = $1, sent = 1 ' +
                "WHERE id = $2 AND tenant_code = $3 AND status = 'pending' AND sent = 0 " +
                'RETURNING id, tenant_code, status, sent',
                ['sent', id, req.tenantId]
            );
            return result.rows[0] || null;
        });
        if (!event) {
            res.status(404).json({ error: 'Event not found or already sent' }); return;
        }
        res.json({ message: 'Event marked as sent', event });
    } catch (error) { next(error); }
});
