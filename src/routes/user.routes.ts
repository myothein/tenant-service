import { Router } from 'express';
import { withTenantClient } from '../lib/db';
import { tenantHandler } from '../utils/tenant-handler';

const router = Router();

/** A bounded, tenant-local directory page. Requests may not select a tenant. */
export function readUserPage(query: Record<string, unknown>) {
    const rawPage = query.page ?? '1';
    const rawLimit = query.limit ?? '20';
    if (typeof rawPage !== 'string' || typeof rawLimit !== 'string' ||
        !/^[1-9][0-9]*$/.test(rawPage) || !/^[1-9][0-9]*$/.test(rawLimit)) {
        return null;
    }
    const page = Number(rawPage);
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(page) || !Number.isSafeInteger(limit) ||
        limit > 100 || (page - 1) * limit > 1_000_000) {
        return null;
    }
    return { page, limit, offset: (page - 1) * limit };
}

/**
 * Admin-only read-only user directory. The server mounts this router behind
 * verified tenant admin authorization and uses the fixed deployment tenant DB.
 * No SELECT *, PII dumps, user mutations, or role escalation endpoints.
 */
router.get('/', tenantHandler(async (req, res, next) => {
    try {
        const pagination = readUserPage(req.query);
        if (!pagination) {
            res.status(400).json({ success: false, code: 'INVALID_PAGINATION' });
            return;
        }
        const data = await withTenantClient(req.tenantId, async client => {
            const result = await client.query(
                'SELECT id, username, first_name, last_name, is_active, role_id, created_at, updated_at ' +
                'FROM "user" ORDER BY username ASC, id ASC LIMIT $1 OFFSET $2',
                [pagination.limit, pagination.offset]
            );
            return result.rows;
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ page: pagination.page, limit: pagination.limit, data });
    } catch (error) {
        next(error);
    }
}));

// User mutations require a separate RBAC and audit-logging acceptance gate.
router.all('*', (_req, res) => {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ success: false, code: 'METHOD_NOT_ALLOWED' });
});

export default router;
