import { Router } from 'express';
import { withTenantClient } from '../lib/db';
import { tenantHandler } from '../utils/tenant-handler';
import { readStudentId, studentWriteGate, createStudent, updateStudent, deleteStudent } from '../services/student.service';
export { readStudentId } from '../services/student.service';

const router = Router();

/** Read-only, fixed-tenant student directory; never emit sensitive student fields. */
export function readStudentPage(query: Record<string, unknown>) {
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
 * Both endpoints are mounted behind verified TENANT_ADMIN OIDC authorization.
 * The fixed tenant DB and tenant_code predicate enforce defense-in-depth scope.
 * Do not return contact, address, DOB, blood type, photo, or other sensitive PII.
 * Mutations require an explicit deployment opt-in and atomic, PII-minimal outbox.
 */
router.get('/', tenantHandler(async (req, res, next) => {
    try {
        const pagination = readStudentPage(req.query);
        if (!pagination) {
            res.status(400).json({ success: false, code: 'INVALID_PAGINATION' });
            return;
        }
        const data = await withTenantClient(req.tenantId, async client => {
            const result = await client.query(
                'SELECT id, name, surname, "classId", "gradeId" FROM student ' +
                'WHERE tenant_code = $1 AND "deletedAt" IS NULL ' +
                'ORDER BY id ASC LIMIT $2 OFFSET $3',
                [req.tenantId, pagination.limit, pagination.offset]
            );
            return result.rows;
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ page: pagination.page, limit: pagination.limit, data });
    } catch (error) { next(error); }
}));

router.get('/:id', tenantHandler(async (req, res, next) => {
    try {
        const id = readStudentId(req.params.id);
        if (!id) {
            res.status(400).json({ success: false, code: 'INVALID_STUDENT_ID' });
            return;
        }
        const student = await withTenantClient(req.tenantId, async client => {
            const result = await client.query(
                'SELECT id, name, surname, "classId", "gradeId" FROM student ' +
                'WHERE id = $1 AND tenant_code = $2 AND "deletedAt" IS NULL LIMIT 1',
                [id, req.tenantId]
            );
            return result.rows[0];
        });
        if (!student) {
            res.status(404).json({ success: false, code: 'STUDENT_NOT_FOUND' });
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json(student);
    } catch (error) { next(error); }
}));

// Opt-in-only writes use the same verified tenant-admin auth as read endpoints.
router.post('/', studentWriteGate, createStudent);
router.put('/:id', studentWriteGate, updateStudent);
router.delete('/:id', studentWriteGate, deleteStudent);

router.all('*', (_req, res) => {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ success: false, code: 'METHOD_NOT_ALLOWED' });
});

export default router;
