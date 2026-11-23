import { Router } from 'express';
import { createSubject, updateSubject, deleteSubject } from '../services/subject.service';
import { withTenantClient } from '../lib/db';
import { tenantHandler } from '../utils/tenant-handler';

const router = Router();

export function readPage(query: Record<string, unknown>): { page: number; limit: number; offset: number } | null {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 20);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 ||
        limit > 100 || (page - 1) * limit > 1_000_000) return null;
    return { page, limit, offset: (page - 1) * limit };
}

router.get('/', tenantHandler(async (req, res, next) => {
    try {
        const pagination = readPage(req.query);
        if (!pagination) {
            res.status(400).json({ error: 'Invalid pagination' });
            return;
        }
        const data = await withTenantClient(req.tenantId, async client => {
            const result = await client.query(
                'SELECT id, name, tenant_code, created_at, updated_at FROM subject ' +
                'WHERE tenant_code = $1 AND deleted_at IS NULL ORDER BY id ASC LIMIT $2 OFFSET $3',
                [req.tenantId, pagination.limit, pagination.offset]
            );
            return result.rows;
        });
        res.json({ page: pagination.page, limit: pagination.limit, data });
    } catch (error) {
        next(error);
    }
}));

router.post('/', createSubject);
router.put('/:id', updateSubject);
router.delete('/:id', deleteSubject);
export default router;
