import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { withTenantClient, runInTransaction } from '../lib/db';
import { tenantHandler } from '../utils/tenant-handler';
import { readStudentId } from '../routes/student.routes';

type StudentView = { id: string; name: string; surname: string; classId: number; gradeId: number };
type StudentCreate = {
    username: string; name: string; surname: string; address: string;
    bloodType: string; sex: string; birthday: string;
    classId: number; gradeId: number; email: string | null; phone: string | null;
};
type StudentRename = { name: string; surname: string };
type Mutation = { kind: 'ok'; student: StudentView } | { kind: 'not_found' } | { kind: 'invalid_class' };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' &&
        !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function allowedKeys(body: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(body).every(key => keys.includes(key));
}
function isText(value: unknown, max: number): value is string {
    return typeof value === 'string' && value === value.trim() &&
        value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function positiveInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
}
function birthDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + 'T00:00:00.000Z');
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value &&
        date.getTime() >= Date.UTC(1900, 0, 1) && date.getTime() <= Date.now();
}
function matchesTenant(body: Record<string, unknown>, tenantId: string): boolean {
    return body.tenant_code === undefined || body.tenant_code === tenantId;
}

export function validateStudentCreate(value: unknown): StudentCreate | null {
    if (!isPlainRecord(value) || !allowedKeys(value, [
        'tenant_code', 'username', 'name', 'surname', 'address', 'bloodType',
        'sex', 'birthday', 'classId', 'gradeId', 'email', 'phone'
    ])) return null;
    const { username, name, surname, address, bloodType, sex, birthday, classId, gradeId, email, phone } = value;
    if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(username) ||
        !isText(name, 150) || !isText(surname, 150) || !isText(address, 300) ||
        !['A_POS','A_NEG','B_POS','B_NEG','AB_POS','AB_NEG','O_POS','O_NEG'].includes(String(bloodType)) ||
        !['MALE','FEMALE'].includes(String(sex)) || !birthDate(birthday) ||
        !positiveInt(classId) || !positiveInt(gradeId)) return null;
    if (email !== undefined && email !== null &&
        (typeof email !== 'string' || email.length > 254 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return null;
    if (phone !== undefined && phone !== null &&
        (typeof phone !== 'string' || !/^[+0-9() .-]{1,30}$/.test(phone))) return null;
    return { username, name, surname, address, bloodType: String(bloodType),
        sex: String(sex), birthday, classId, gradeId,
        email: typeof email === 'string' ? email : null,
        phone: typeof phone === 'string' ? phone : null };
}
export function validateStudentRename(value: unknown): StudentRename | null {
    if (!isPlainRecord(value) || !allowedKeys(value, ['tenant_code', 'name', 'surname']) ||
        !isText(value.name, 150) || !isText(value.surname, 150)) return null;
    return { name: value.name, surname: value.surname };
}

/**
 * Explicitly disabled unless the deployment owner opts in. A production write
 * additionally requires a signature-verified OIDC subject set by requireApiRole.
 * The legacy QA authentication path can never reach this gate in production.
 */
export function studentWriteGate(_req: Request, res: Response, next: NextFunction) {
    if (process.env.TENANT_STUDENT_WRITES_ENABLED !== 'true') {
        return res.status(405).json({ success: false, code: 'STUDENT_WRITES_DISABLED' });
    }
    if (process.env.NODE_ENV === 'production' &&
        (typeof res.locals.subject !== 'string' || res.locals.subject.length === 0)) {
        return res.status(403).json({ success: false, code: 'STUDENT_WRITE_IDENTITY_REQUIRED' });
    }
    next();
}
function auditActor(res: Response): string {
    return typeof res.locals.subject === 'string' && res.locals.subject.length > 0
        ? res.locals.subject : 'nonproduction-legacy-qa';
}
async function writeStudentEvent(
    client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
    tenant: string, kind: 'created'|'updated'|'deleted', student: StudentView, actor: string
) {
    // No name, surname, address, birthdate, contact info, or medical data in events.
    const payload = { student_id: student.id, tenant_code: tenant,
        class_id: student.classId, grade_id: student.gradeId };
    const headers = { actor_subject: actor };
    await client.query(
        "INSERT INTO local_events (id,tenant_code,agent_id,aggregate_type,aggregate_id," +
        "event_type,payload,created_at,occurred_at,sent,status,retry_count,event_version,headers) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW(),NOW(),0,'pending',0,1,$8::jsonb)",
        [randomUUID(), tenant, 'tenant-service', 'Student', student.id,
            'student.' + kind, JSON.stringify(payload), JSON.stringify(headers)]
    );
}
function respondWriteError(error: unknown, res: Response, next: NextFunction) {
    const code = (error as { code?: string })?.code;
    if (code === '23505') {
        res.status(409).json({ success: false, code: 'STUDENT_ALREADY_EXISTS' });
    } else if (code === '23503') {
        res.status(409).json({ success: false, code: 'STUDENT_RELATION_CONFLICT' });
    } else {
        next(error);
    }
}
export const createStudent = tenantHandler(async (req, res, next) => {
    if (!isPlainRecord(req.body)) {
        res.status(400).json({ success: false, code: 'INVALID_STUDENT_INPUT' }); return;
    }
    if (!matchesTenant(req.body, req.tenantId)) {
        res.status(403).json({ success: false, code: 'TENANT_FORBIDDEN' }); return;
    }
    const input = validateStudentCreate(req.body);
    if (!input) {
        res.status(400).json({ success: false, code: 'INVALID_STUDENT_INPUT' }); return;
    }
    try {
        const result = await withTenantClient(req.tenantId, client =>
            runInTransaction(client, async (): Promise<Mutation> => {
                const group = await client.query(
                    'SELECT c.id FROM "class" c JOIN grade g ON g.id=c."gradeId" ' +
                    'AND g.tenant_code=c.tenant_code WHERE c.id=$1 AND g.id=$2 ' +
                    'AND c.tenant_code=$3 FOR SHARE OF c,g',
                    [input.classId, input.gradeId, req.tenantId]
                );
                if (!group.rows.length) return { kind: 'invalid_class' };
                const id = randomUUID();
                const created = await client.query<StudentView>(
                    'INSERT INTO student (id,tenant_code,username,name,surname,email,phone,address,' +
                    '"bloodType",sex,birthday,"classId","gradeId","updatedAt") ' +
                    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()) ' +
                    'RETURNING id,name,surname,"classId","gradeId"',
                    [id, req.tenantId, input.username, input.name, input.surname, input.email,
                        input.phone, input.address, input.bloodType, input.sex, input.birthday,
                        input.classId, input.gradeId]
                );
                const student = created.rows[0];
                await writeStudentEvent(client, req.tenantId, 'created', student, auditActor(res));
                return { kind: 'ok', student };
            })
        );
        if (result.kind === 'invalid_class') {
            res.status(422).json({ success: false, code: 'STUDENT_CLASS_GRADE_MISMATCH' }); return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.status(201).json(result.student);
    } catch (error) { respondWriteError(error, res, next); }
});
export const updateStudent = tenantHandler(async (req, res, next) => {
    const id = readStudentId(req.params.id);
    if (!id || !isPlainRecord(req.body)) {
        res.status(400).json({ success: false, code: 'INVALID_STUDENT_INPUT' }); return;
    }
    if (!matchesTenant(req.body, req.tenantId)) {
        res.status(403).json({ success: false, code: 'TENANT_FORBIDDEN' }); return;
    }
    const input = validateStudentRename(req.body);
    if (!input) {
        res.status(400).json({ success: false, code: 'INVALID_STUDENT_INPUT' }); return;
    }
    try {
        const result = await withTenantClient(req.tenantId, client =>
            runInTransaction(client, async (): Promise<Mutation> => {
                const updated = await client.query<StudentView>(
                    'UPDATE student SET name=$1,surname=$2,"updatedAt"=NOW() ' +
                    'WHERE id=$3 AND tenant_code=$4 AND "deletedAt" IS NULL ' +
                    'RETURNING id,name,surname,"classId","gradeId"',
                    [input.name, input.surname, id, req.tenantId]
                );
                if (!updated.rows[0]) return { kind: 'not_found' };
                await writeStudentEvent(client, req.tenantId, 'updated', updated.rows[0], auditActor(res));
                return { kind: 'ok', student: updated.rows[0] };
            })
        );
        if (result.kind === 'not_found') {
            res.status(404).json({ success: false, code: 'STUDENT_NOT_FOUND' }); return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json(result.student);
    } catch (error) { respondWriteError(error, res, next); }
});
export const deleteStudent = tenantHandler(async (req, res, next) => {
    const id = readStudentId(req.params.id);
    const body: unknown = req.body === undefined ? {} : req.body;
    if (!id || !isPlainRecord(body) || !allowedKeys(body, ['tenant_code'])) {
        res.status(400).json({ success: false, code: 'INVALID_STUDENT_INPUT' }); return;
    }
    if (!matchesTenant(body, req.tenantId)) {
        res.status(403).json({ success: false, code: 'TENANT_FORBIDDEN' }); return;
    }
    try {
        const result = await withTenantClient(req.tenantId, client =>
            runInTransaction(client, async (): Promise<Mutation> => {
                const deleted = await client.query<StudentView>(
                    'UPDATE student SET "deletedAt"=NOW(),"updatedAt"=NOW() ' +
                    'WHERE id=$1 AND tenant_code=$2 AND "deletedAt" IS NULL ' +
                    'RETURNING id,name,surname,"classId","gradeId"',
                    [id, req.tenantId]
                );
                if (!deleted.rows[0]) return { kind: 'not_found' };
                await writeStudentEvent(client, req.tenantId, 'deleted', deleted.rows[0], auditActor(res));
                return { kind: 'ok', student: deleted.rows[0] };
            })
        );
        if (result.kind === 'not_found') {
            res.status(404).json({ success: false, code: 'STUDENT_NOT_FOUND' }); return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json(result.student);
    } catch (error) { respondWriteError(error, res, next); }
});
