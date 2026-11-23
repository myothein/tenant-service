import { createHash, createHmac } from 'node:crypto';
import type { Request } from 'express';
import type { PoolClient } from 'pg';

export type StudentView = {
    id: string; name: string; surname: string; classId: number; gradeId: number
};
export type StudentMutationResult =
    | { kind: 'ok'; student: StudentView }
    | { kind: 'not_found' }
    | { kind: 'invalid_class' };

type LedgerRow = {
    principal_id: string; operation: string; resource_id: string;
    request_digest: string; response_status: number | null;
    response_body: StudentView | null
};
type ReplayContext = {
    tenant: string; actor: string; rawKey: string;
    operation: 'student.create' | 'student.update' | 'student.delete';
    resource: string; normalizedBody: object; status: 200 | 201
};

/** Single high-entropy client token per logical mutation. Never log or persist raw keys. */
export function readStudentIdempotencyKey(req: Request): string | null {
    const value = req.headers['idempotency-key'];
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) return null;
    const appearances = req.rawHeaders.filter((part, index) =>
        index % 2 === 0 && part.toLowerCase() === 'idempotency-key').length;
    if (appearances !== 1) return null;
    // Reject obvious non-random placeholder tokens; caller must use CSPRNG random bytes/UUID.
    if (/^(.)\1+$/.test(value)) return null;
    return value;
}

export class StudentIdempotencyConflict extends Error {
    constructor() { super('Student idempotency key was already used with different request or principal'); }
}
export class StudentIdempotencyPending extends Error {
    constructor() { super('Student idempotency record missing committed response'); }
}

/**
 * Must execute INSIDE the same PostgreSQL transaction as domain and local_events.
 * Unique (tenant_code, key_digest) serializes retries, including concurrent requests;
 * a failed domain/outbox write rolls back its ledger reservation, too.
 * HMAC uses the unpublished random client key to avoid storing unhashed PII fingerprints.
 */
export async function runStudentWriteOnce(
    client: PoolClient,
    ctx: ReplayContext,
    action: () => Promise<StudentMutationResult>
): Promise<{ result: StudentMutationResult; replayed: boolean }> {
    const keyDigest = createHash('sha256').update(ctx.rawKey, 'utf8').digest('hex');
    const requestDigest = createHmac('sha256', ctx.rawKey)
        .update(JSON.stringify({
            operation: ctx.operation, resource: ctx.resource, body: ctx.normalizedBody
        }), 'utf8')
        .digest('hex');
    const reservation = await client.query<{ key_digest: string }>(
        'INSERT INTO student_write_idempotency ' +
        '(tenant_code,key_digest,principal_id,operation,resource_id,request_digest) ' +
        'VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING key_digest',
        [ctx.tenant, keyDigest, ctx.actor, ctx.operation, ctx.resource, requestDigest]
    );
    if (!reservation.rows.length) {
        const existing = await client.query<LedgerRow>(
            'SELECT principal_id,operation,resource_id,request_digest,response_status,response_body ' +
            'FROM student_write_idempotency WHERE tenant_code=$1 AND key_digest=$2 FOR UPDATE',
            [ctx.tenant, keyDigest]
        );
        const recorded = existing.rows[0];
        if (!recorded) throw new StudentIdempotencyPending();
        if (recorded.principal_id !== ctx.actor || recorded.operation !== ctx.operation ||
            recorded.resource_id !== ctx.resource || recorded.request_digest !== requestDigest ||
            recorded.response_status !== ctx.status) {
            throw new StudentIdempotencyConflict();
        }
        if (!recorded.response_body ||
            typeof recorded.response_body.id !== 'string' ||
            typeof recorded.response_body.name !== 'string' ||
            typeof recorded.response_body.surname !== 'string' ||
            !Number.isInteger(recorded.response_body.classId) ||
            !Number.isInteger(recorded.response_body.gradeId)) {
            throw new StudentIdempotencyPending();
        }
        return { result: { kind: 'ok', student: recorded.response_body }, replayed: true };
    }

    const result = await action();
    if (result.kind !== 'ok') {
        // Do not retain a key for an operation that did not mutate a domain record.
        await client.query(
            'DELETE FROM student_write_idempotency WHERE tenant_code=$1 AND key_digest=$2',
            [ctx.tenant, keyDigest]
        );
        return { result, replayed: false };
    }
    await client.query(
        'UPDATE student_write_idempotency SET response_status=$3,response_body=$4::jsonb ' +
        'WHERE tenant_code=$1 AND key_digest=$2',
        [ctx.tenant, keyDigest, ctx.status, JSON.stringify(result.student)]
    );
    return { result, replayed: false };
}
