import { randomUUID } from 'node:crypto';
import { withTenantClient, runInTransaction } from '../lib/db';
import { tenantHandler } from '../utils/tenant-handler';

type Subject = { id: number; name: string; tenant_code: string };

export function validateSubjectName(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 150;
}
function trustedTenant(req: { tenantId: string; body: any }): boolean {
    return req.body?.tenant_code === undefined || req.body.tenant_code === req.tenantId;
}
function parseId(value: string): number | null {
    const n = Number(value);
    return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(n) ? n : null;
}
async function writeEvent(client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
    tenantId: string, eventType: string, subject: Subject): Promise<void> {
    await client.query(
        'INSERT INTO local_events (id,tenant_code,agent_id,aggregate_type,aggregate_id,' +
        'event_type,payload,created_at,occurred_at,sent,status,retry_count,event_version,headers) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW(),NOW(),0,\'pending\',0,1,\'{}\'::jsonb)',
        [randomUUID(), tenantId, 'tenant-service', 'Subject', String(subject.id),
            eventType, JSON.stringify(subject)]
    );
}

export const createSubject = tenantHandler(async (req, res, next) => {
    const name: unknown = req.body?.name;
    if (!validateSubjectName(name)) {
        res.status(400).json({ error: 'Subject name must be 1-150 characters' }); return;
    }
    if (!trustedTenant(req)) {
        res.status(403).json({ error: 'Cross-tenant write rejected' }); return;
    }
    try {
        const subject = await withTenantClient(req.tenantId, async client =>
            runInTransaction(client, async () => {
                const result = await client.query<Subject>(
                    'INSERT INTO subject (tenant_code,name,created_at,updated_at) ' +
                    'VALUES ($1,$2,NOW(),NOW()) RETURNING id,name,tenant_code',
                    [req.tenantId, name.trim()]
                );
                const inserted = result.rows[0];
                await writeEvent(client, req.tenantId, 'subject.created', inserted);
                return inserted;
            })
        );
        res.status(201).json(subject);
    } catch (error) {
        if ((error as { code?: string }).code === '23505') {
            res.status(409).json({ error: 'Subject already exists for tenant' });
        } else next(error);
    }
});

export const updateSubject = tenantHandler(async (req, res, next) => {
    const name: unknown = req.body?.name;
    const id = parseId(req.params.id);
    if (!id || !validateSubjectName(name)) {
        res.status(400).json({ error: 'Valid subject id and name required' }); return;
    }
    if (!trustedTenant(req)) {
        res.status(403).json({ error: 'Cross-tenant write rejected' }); return;
    }
    try {
        const subject = await withTenantClient(req.tenantId, async client =>
            runInTransaction(client, async () => {
                const result = await client.query<Subject>(
                    'UPDATE subject SET name=$1,updated_at=NOW() ' +
                    'WHERE id=$2 AND tenant_code=$3 AND deleted_at IS NULL RETURNING id,name,tenant_code',
                    [name.trim(), id, req.tenantId]
                );
                const updated = result.rows[0];
                if (updated) await writeEvent(client, req.tenantId, 'subject.updated', updated);
                return updated;
            })
        );
        if (!subject) { res.status(404).json({ error: 'Subject not found' }); return; }
        res.json(subject);
    } catch (error) {
        if ((error as { code?: string }).code === '23505') {
            res.status(409).json({ error: 'Subject already exists for tenant' });
        } else next(error);
    }
});

export const deleteSubject = tenantHandler(async (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) { res.status(400).json({ error: 'Valid subject id required' }); return; }
    if (!trustedTenant(req)) {
        res.status(403).json({ error: 'Cross-tenant write rejected' }); return;
    }
    try {
        const subject = await withTenantClient(req.tenantId, async client =>
            runInTransaction(client, async () => {
                const result = await client.query<Subject>(
                    'UPDATE subject SET deleted_at=NOW(),updated_at=NOW() ' +
                    'WHERE id=$1 AND tenant_code=$2 AND deleted_at IS NULL RETURNING id,name,tenant_code',
                    [id, req.tenantId]
                );
                const deleted = result.rows[0];
                if (deleted) await writeEvent(client, req.tenantId, 'subject.deleted', deleted);
                return deleted;
            })
        );
        if (!subject) { res.status(404).json({ error: 'Subject not found' }); return; }
        res.json(subject);
    } catch (error) { next(error); }
});
