import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server';
import { Client } from 'pg';
import { getTenantPool, assertRuntimeDbRole } from '../lib/db';

const tenant = 'tenant_ci_qa';
const admin = 'ci-only-admin-credential-longer-than-32-bytes';
const agent = 'ci-only-agent-credential-longer-than-32-bytes';

async function api(path: string, opts: RequestInit = {}) {
    const listener = createApp(tenant).listen(0, '127.0.0.1');
    try {
        await once(listener, 'listening');
        const address = listener.address();
        if (!address || typeof address === 'string') throw new Error('No test listener');
        const r = await fetch('http://127.0.0.1:' + address.port + path, opts);
        const data = await r.json() as any;
        return { status: r.status, data };
    } finally {
        await new Promise<void>((resolve, reject) =>
            listener.close(error => error ? reject(error) : resolve())
        );
    }
}

const adminHeaders = { authorization: 'Bearer ' + admin, 'content-type': 'application/json' };
const agentHeaders = { authorization: 'Bearer ' + agent };

test('PostgreSQL schema: tenant-scoped Subject CRUD persists matching outbox events', {
    skip: process.env.RUN_PG_INTEGRATION !== '1'
}, async () => {
    process.env.TENANT_ADMIN_API_KEY = admin;
    process.env.TENANT_AGENT_API_KEY = agent;
    const name = 'CI-' + randomUUID();
    const created = await api('/subjects', {
        method: 'POST', headers: adminHeaders, body: JSON.stringify({ name })
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.id;
    assert.equal(created.data.tenant_code, tenant);
    assert.equal(created.data.name, name);

    const pool = getTenantPool(tenant);
    const eventRows = await pool.query(
        "SELECT id,tenant_code,status,sent,event_type FROM local_events WHERE tenant_code=$1 AND aggregate_id=$2",
        [tenant, String(id)]
    );
    assert.equal(eventRows.rowCount, 1);
    assert.equal(eventRows.rows[0].event_type, 'subject.created');
    assert.equal(eventRows.rows[0].sent, 0);

    const listed = await api('/subjects?limit=10', { headers: adminHeaders });
    assert.equal(listed.status, 200);
    assert.ok(listed.data.data.some((row: { id: number }) => row.id === id));

    const pending = await api('/local-events/pending', { headers: agentHeaders });
    assert.equal(pending.status, 200);
    assert.ok(pending.data.data.some((row: { id: string }) => row.id === eventRows.rows[0].id));

    const ack = await api('/local-events/' + eventRows.rows[0].id + '/mark-sent', {
        method: 'PATCH', headers: agentHeaders
    });
    assert.equal(ack.status, 200);
    assert.equal(ack.data.event.status, 'sent');

    const updated = await api('/subjects/' + id, {
        method: 'PUT', headers: adminHeaders, body: JSON.stringify({ name: name + '-update' })
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));

    const deleted = await api('/subjects/' + id, {
        method: 'DELETE', headers: adminHeaders
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));

    const finalEvents = await pool.query(
        'SELECT event_type FROM local_events WHERE tenant_code=$1 AND aggregate_id=$2 ORDER BY created_at',
        [tenant, String(id)]
    );
    assert.deepEqual(finalEvents.rows.map(r => r.event_type).sort(),
        ['subject.created', 'subject.deleted', 'subject.updated']);
    const row = await pool.query('SELECT deleted_at FROM subject WHERE id=$1 AND tenant_code=$2', [id, tenant]);
    assert.ok(row.rows[0].deleted_at);
});

test('PostgreSQL transactional rollback: failed outbox insert cannot commit subject', {
    skip: process.env.RUN_PG_INTEGRATION !== '1'
}, async () => {
    process.env.TENANT_ADMIN_API_KEY = admin;
    const pool = getTenantPool(tenant);
    const unique = 'CI-rollback-' + randomUUID();
    await pool.query(
        "ALTER TABLE local_events ADD CONSTRAINT ci_reject_created_event CHECK (event_type <> 'subject.created') NOT VALID"
    );
    try {
        const response = await api('/subjects', {
            method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: unique })
        });
        assert.equal(response.status, 500, JSON.stringify(response.data));
        const count = await pool.query(
            'SELECT COUNT(*)::integer AS count FROM subject WHERE tenant_code=$1 AND name=$2',
            [tenant, unique]
        );
        assert.equal(count.rows[0].count, 0, 'A failed outbox insert must roll back the domain write');
    } finally {
        await pool.query('ALTER TABLE local_events DROP CONSTRAINT IF EXISTS ci_reject_created_event');
    }
});

test('PostgreSQL 17 production database role gate rejects actual superuser', {
    skip:process.env.RUN_PG_INTEGRATION !== '1'
},async()=>{
    const pool=getTenantPool(tenant);
    const client=await pool.connect();
    const original={env:process.env.NODE_ENV,expected:process.env.TENANT_DB_EXPECTED_ROLE};
    process.env.NODE_ENV='production';
    process.env.TENANT_DB_EXPECTED_ROLE='ci_qa';
    try {
        await assert.rejects(()=>assertRuntimeDbRole(client),/unsafe privileges/);
    }finally{
        client.release();
        if(original.env===undefined)delete process.env.NODE_ENV;
        else process.env.NODE_ENV=original.env;
        if(original.expected===undefined)delete process.env.TENANT_DB_EXPECTED_ROLE;
        else process.env.TENANT_DB_EXPECTED_ROLE=original.expected;
    }
});

test('PostgreSQL 17 accepts only dedicated least-privilege tenant runtime role',{
    skip:process.env.RUN_PG_INTEGRATION !== '1'
},async()=>{
    const runtimeRole='tenant_ci_runtime';
    const password='ci_only_runtime_password_longer_than_32_bytes';
    const adminPool=getTenantPool(tenant);
    const admin=await adminPool.connect();
    try {
        await admin.query(
            "CREATE ROLE tenant_ci_runtime LOGIN PASSWORD 'ci_only_runtime_password_longer_than_32_bytes' " +
            'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
        );
        await admin.query('GRANT CONNECT ON DATABASE tenant_ci_qa TO tenant_ci_runtime');
        await admin.query('GRANT USAGE ON SCHEMA public TO tenant_ci_runtime');
        await admin.query('GRANT SELECT ON TABLE subject TO tenant_ci_runtime');
    } finally { admin.release(); }
    const client=new Client({
        host:'127.0.0.1',port:5432,user:runtimeRole,password,database:tenant
    });
    const original={env:process.env.NODE_ENV,role:process.env.TENANT_DB_EXPECTED_ROLE};
    try {
        await client.connect();
        process.env.NODE_ENV='production';
        process.env.TENANT_DB_EXPECTED_ROLE=runtimeRole;
        await assertRuntimeDbRole(client);
        const result=await client.query('SELECT COUNT(*)::int AS n FROM subject');
        assert.ok(result.rows[0].n>=0);
        await assert.rejects(()=>client.query('CREATE ROLE qa_escalated_privileges'),/permission denied/);
    }finally{
        await client.end();
        if(original.env===undefined)delete process.env.NODE_ENV;
        else process.env.NODE_ENV=original.env;
        if(original.role===undefined)delete process.env.TENANT_DB_EXPECTED_ROLE;
        else process.env.TENANT_DB_EXPECTED_ROLE=original.role;
    }
});

test('PostgreSQL user directory is admin-only, bounded, and never SELECT *', {
    skip: process.env.RUN_PG_INTEGRATION !== '1'
}, async () => {
    process.env.TENANT_ADMIN_API_KEY = admin;
    process.env.TENANT_AGENT_API_KEY = agent;
    const id = randomUUID();
    const username = 'qa-directory-' + id;
    const pool = getTenantPool(tenant);
    await pool.query(
        'INSERT INTO "user" (id, username, first_name, last_name, is_active, created_at, updated_at) ' +
        'VALUES ($1, $2, $3, $4, TRUE, NOW(), NOW())',
        [id, username, 'QA', 'Directory']
    );
    try {
        const listed = await api('/users?page=1&limit=100', { headers: adminHeaders });
        assert.equal(listed.status, 200, JSON.stringify(listed.data));
        assert.equal(listed.data.page, 1);
        assert.equal(listed.data.limit, 100);
        const found = listed.data.data.find((user: { id: string }) => user.id === id);
        assert.ok(found, 'Inserted user should be in the tenant-local directory');
        assert.equal(found.username, username);
        assert.deepEqual(Object.keys(found).sort(), [
            'id', 'username', 'first_name', 'last_name',
            'is_active', 'role_id', 'created_at', 'updated_at'
        ].sort(), 'Only approved fields can leave the tenant DB');
        assert.equal('email' in found, false);

        const invalid = await api('/users?page=0&limit=500', { headers: adminHeaders });
        assert.equal(invalid.status, 400);
        const denied = await api('/users?limit=100');
        assert.equal(denied.status, 401);
        const crossTenant = await api('/users', {
            headers: { ...adminHeaders, 'x-tenant-id': 'another-school' }
        });
        assert.equal(crossTenant.status, 403);
        const creation = await api('/users', {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({ username: 'unauthorized-create' })
        });
        assert.equal(creation.status, 405, 'User mutation methods must fail closed');
        assert.equal(creation.data.code, 'METHOD_NOT_ALLOWED');
    } finally {
        await pool.query('DELETE FROM "user" WHERE id=$1', [id]);
    }
});


test('PostgreSQL student directory enforces row-level tenant filtering, soft deletes and PII projection', {
    skip: process.env.RUN_PG_INTEGRATION !== '1'
}, async () => {
    process.env.TENANT_ADMIN_API_KEY = admin;
    process.env.TENANT_AGENT_API_KEY = agent;
    const pool = getTenantPool(tenant);
    const otherTenant = 'another-ci-tenant';
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const gradeIds: number[] = [];
    const classIds: number[] = [];
    try {
        for (const [index, tenantCode] of [tenant, otherTenant].entries()) {
            const grade = await pool.query(
                'INSERT INTO grade (tenant_code, level) VALUES ($1, $2) RETURNING id',
                [tenantCode, 900001 + index]
            );
            const gradeId = grade.rows[0].id as number;
            gradeIds.push(gradeId);
            const classroom = await pool.query(
                'INSERT INTO "class" (tenant_code, name, capacity, "gradeId") VALUES ($1, $2, $3, $4) RETURNING id',
                [tenantCode, 'CI-class-' + ids[index], 30, gradeId]
            );
            classIds.push(classroom.rows[0].id as number);
        }
        for (const [index, studentId] of ids.entries()) {
            const tenantCode = index === 1 ? otherTenant : tenant;
            const group = index === 1 ? 1 : 0;
            await pool.query(
                'INSERT INTO student (id, tenant_code, username, name, surname, address, "bloodType", sex, birthday, "classId", "gradeId", "updatedAt", "deletedAt") ' +
                'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12)',
                [studentId, tenantCode, 'ci-student-' + studentId, 'Synthetic', 'QA', 'synthetic-only',
                    'O_POS', 'MALE', '2001-01-01', classIds[group], gradeIds[group], index === 2 ? new Date() : null]
            );
        }
        const listing = await api('/students?page=1&limit=100', { headers: adminHeaders });
        assert.equal(listing.status, 200, JSON.stringify(listing.data));
        assert.equal(listing.data.page, 1);
        assert.equal(listing.data.limit, 100);
        const own = listing.data.data.find((student: {id: string}) => student.id === ids[0]);
        assert.ok(own, 'Own-tenant synthetic student should be listed');
        assert.deepEqual(Object.keys(own).sort(), ['id', 'name', 'surname', 'classId', 'gradeId'].sort());
        assert.ok(!listing.data.data.some((student: {id: string}) => student.id === ids[1]),
            'Another tenant cannot be enumerated even in the same PostgreSQL database');
        assert.ok(!listing.data.data.some((student: {id: string}) => student.id === ids[2]),
            'Soft-deleted student cannot be enumerated');

        const detail = await api('/students/' + ids[0], { headers: adminHeaders });
        assert.equal(detail.status, 200);
        assert.deepEqual(Object.keys(detail.data).sort(), ['id', 'name', 'surname', 'classId', 'gradeId'].sort());
        const crossTenant = await api('/students/' + ids[1], { headers: adminHeaders });
        assert.equal(crossTenant.status, 404);
        assert.equal(crossTenant.data.code, 'STUDENT_NOT_FOUND');
        assert.equal((await api('/students/' + ids[2], { headers: adminHeaders })).status, 404);

        assert.equal((await api('/students?page=1&limit=100')).status, 401);
        assert.equal((await api('/students', {
            headers: {...adminHeaders, 'x-tenant-code': otherTenant}
        })).status, 403);
        const mutate = await api('/students/' + ids[0], { method: 'DELETE', headers: adminHeaders });
        assert.equal(mutate.status, 405);
        assert.equal(mutate.data.code, 'STUDENT_WRITES_DISABLED');
    } finally {
        await pool.query('DELETE FROM student WHERE id = ANY($1::text[])', [ids]);
        if (classIds.length) await pool.query('DELETE FROM "class" WHERE id = ANY($1::integer[])', [classIds]);
        if (gradeIds.length) await pool.query('DELETE FROM grade WHERE id = ANY($1::integer[])', [gradeIds]);
    }
});


test('PostgreSQL student column-privilege role cannot read private columns or mutate students', {
    skip: process.env.RUN_PG_INTEGRATION !== '1'
}, async () => {
    // CI-only synthetic role on disposable PostgreSQL 17, never provisioned in production.
    const role = 'tenant_ci_student_reader';
    const password = 'ci-synthetic-student-column-reader-credential';
    const pool = getTenantPool(tenant);
    const admin = await pool.connect();
    let created = false;
    try {
        await admin.query(
            "CREATE ROLE tenant_ci_student_reader LOGIN PASSWORD 'ci-synthetic-student-column-reader-credential' " +
            'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
        );
        created = true;
        await admin.query('GRANT CONNECT ON DATABASE tenant_ci_qa TO tenant_ci_student_reader');
        await admin.query('GRANT USAGE ON SCHEMA public TO tenant_ci_student_reader');
        await admin.query(
            'GRANT SELECT (id, name, surname, "classId", "gradeId", tenant_code, "deletedAt") ' +
            'ON TABLE student TO tenant_ci_student_reader'
        );
        const reader = new Client({
            host: '127.0.0.1', port: 5432, database: tenant, user: role, password
        });
        try {
            await reader.connect();
            // The least-privilege role may execute the precise read-only API query.
            const rows = await reader.query(
                'SELECT id, name, surname, "classId", "gradeId" FROM student ' +
                'WHERE tenant_code = $1 AND "deletedAt" IS NULL LIMIT 1',
                [tenant]
            );
            assert.ok(Array.isArray(rows.rows));
            // Credential compromise must not grant access to extra student PII.
            await assert.rejects(() => reader.query('SELECT email FROM student LIMIT 1'), /permission denied/);
            await assert.rejects(() => reader.query('SELECT birthday FROM student LIMIT 1'), /permission denied/);
            await assert.rejects(() => reader.query('SELECT * FROM student LIMIT 1'), /permission denied/);
            await assert.rejects(() => reader.query('DELETE FROM student WHERE false'), /permission denied/);
        } finally {
            await reader.end();
        }
    } finally {
        if (created) {
            await admin.query('REVOKE ALL PRIVILEGES ON TABLE student FROM tenant_ci_student_reader');
            // Column grants must be explicitly revoked to drop the temporary role.
            await admin.query(
                'REVOKE SELECT (id, name, surname, "classId", "gradeId", tenant_code, "deletedAt") ' +
                'ON TABLE student FROM tenant_ci_student_reader'
            );
            await admin.query('REVOKE USAGE ON SCHEMA public FROM tenant_ci_student_reader');
            await admin.query('REVOKE CONNECT ON DATABASE tenant_ci_qa FROM tenant_ci_student_reader');
            await admin.query('DROP ROLE tenant_ci_student_reader');
        }
        admin.release();
    }
});


/** Disposable PostgreSQL fixtures only. No production data or real pupils. */
async function prepareStudentWriteFixture() {
    const pool = getTenantPool(tenant);
    const code = randomUUID();
    const grade = await pool.query(
        'INSERT INTO grade (tenant_code, level) VALUES ($1,$2) RETURNING id',
        [tenant, 920001]
    );
    const gradeId = grade.rows[0].id as number;
    const classroom = await pool.query(
        'INSERT INTO "class" (tenant_code, name, capacity, "gradeId") ' +
        'VALUES ($1,$2,$3,$4) RETURNING id',
        [tenant, 'CI-write-' + code, 30, gradeId]
    );
    return { pool, classId: classroom.rows[0].id as number, gradeId, code };
}

test('PostgreSQL student writes create, rename and soft-delete with PII-minimal atomic outbox', {
    skip: process.env.RUN_PG_INTEGRATION !== '1'
}, async () => {
    process.env.TENANT_ADMIN_API_KEY = admin;
    process.env.TENANT_AGENT_API_KEY = agent;
    const priorFlag = process.env.TENANT_STUDENT_WRITES_ENABLED;
    process.env.TENANT_STUDENT_WRITES_ENABLED = 'true';
    const fixture = await prepareStudentWriteFixture();
    let studentId: string | undefined;
    try {
        const input = { username: 'ci-write-' + fixture.code, name: 'Synthetic',
            surname: 'Only', address: 'CI-only synthetic address',
            bloodType: 'O_POS', sex: 'MALE', birthday: '2001-01-01',
            classId: fixture.classId, gradeId: fixture.gradeId,
            email: 'synthetic@example.invalid', phone: '+100000000' };
        const created = await api('/students', {
            method: 'POST', headers: adminHeaders, body: JSON.stringify(input)
        });
        assert.equal(created.status, 201, JSON.stringify(created.data));
        studentId = created.data.id;
        assert.equal(typeof studentId, 'string');
        assert.deepEqual(Object.keys(created.data).sort(),
            ['id','name','surname','classId','gradeId'].sort());

        const persisted = await fixture.pool.query(
            'SELECT tenant_code,username,address,email,"deletedAt" FROM student WHERE id=$1',
            [studentId]
        );
        assert.equal(persisted.rowCount, 1);
        assert.equal(persisted.rows[0].tenant_code, tenant);
        assert.equal(persisted.rows[0].email, input.email);
        const originalEvents = await fixture.pool.query(
            'SELECT event_type,payload,headers FROM local_events WHERE tenant_code=$1 ' +
            'AND aggregate_type=$2 AND aggregate_id=$3',
            [tenant, 'Student', studentId]
        );
        assert.equal(originalEvents.rowCount, 1);
        assert.equal(originalEvents.rows[0].event_type, 'student.created');
        assert.deepEqual(Object.keys(originalEvents.rows[0].payload).sort(),
            ['student_id','tenant_code','class_id','grade_id'].sort());
        assert.equal(originalEvents.rows[0].payload.student_id, studentId);
        assert.equal(originalEvents.rows[0].headers.actor_subject, 'nonproduction-legacy-qa');
        assert.ok(!JSON.stringify(originalEvents.rows[0]).includes('synthetic@example.invalid'));

        const updated = await api('/students/' + studentId, {
            method: 'PUT', headers: adminHeaders,
            body: JSON.stringify({ name: 'Updated', surname: 'Synthetic' })
        });
        assert.equal(updated.status, 200, JSON.stringify(updated.data));
        assert.equal(updated.data.name, 'Updated');
        const softDeleted = await api('/students/' + studentId, {
            method: 'DELETE', headers: adminHeaders
        });
        assert.equal(softDeleted.status, 200, JSON.stringify(softDeleted.data));
        const hidden = await api('/students/' + studentId, { headers: adminHeaders });
        assert.equal(hidden.status, 404, 'Soft-deleted student must not be exposed');
        const events = await fixture.pool.query(
            'SELECT event_type,payload,status,sent FROM local_events WHERE tenant_code=$1 ' +
            'AND aggregate_type=$2 AND aggregate_id=$3',
            [tenant, 'Student', studentId]
        );
        assert.deepEqual(events.rows.map(r => r.event_type).sort(),
            ['student.created','student.deleted','student.updated']);
        assert.ok(events.rows.every(r => r.status === 'pending' && r.sent === 0));
        assert.ok(events.rows.every(r => Object.keys(r.payload).length === 4));
    } finally {
        if (studentId) {
            await fixture.pool.query(
                'DELETE FROM local_events WHERE aggregate_type=$1 AND aggregate_id=$2 AND tenant_code=$3',
                ['Student', studentId, tenant]
            );
            await fixture.pool.query('DELETE FROM student WHERE id=$1', [studentId]);
        }
        await fixture.pool.query('DELETE FROM "class" WHERE id=$1', [fixture.classId]);
        await fixture.pool.query('DELETE FROM grade WHERE id=$1', [fixture.gradeId]);
        if (priorFlag === undefined) delete process.env.TENANT_STUDENT_WRITES_ENABLED;
        else process.env.TENANT_STUDENT_WRITES_ENABLED = priorFlag;
    }
});

test('PostgreSQL student creation rejects wrong-tenant classes and rolls back on outbox failure', {
    skip: process.env.RUN_PG_INTEGRATION !== '1'
}, async () => {
    process.env.TENANT_ADMIN_API_KEY = admin;
    process.env.TENANT_AGENT_API_KEY = agent;
    const priorFlag = process.env.TENANT_STUDENT_WRITES_ENABLED;
    process.env.TENANT_STUDENT_WRITES_ENABLED = 'true';
    const fixture = await prepareStudentWriteFixture();
    const username = 'ci-rollback-' + fixture.code;
    const input = { username, name: 'Synthetic', surname: 'Rollback',
        address: 'CI fake address', bloodType: 'O_POS', sex: 'FEMALE',
        birthday: '2002-05-07', classId: fixture.classId, gradeId: fixture.gradeId };
    let constraintCreated = false;
    try {
        const wrongClass = await api('/students', {
            method: 'POST', headers: adminHeaders,
            body: JSON.stringify({ ...input, gradeId: fixture.gradeId + 999 })
        });
        assert.equal(wrongClass.status, 422);
        assert.equal(wrongClass.data.code, 'STUDENT_CLASS_GRADE_MISMATCH');

        const anotherTenant = await api('/students', {
            method: 'POST', headers: adminHeaders,
            body: JSON.stringify({ ...input, tenant_code: 'foreign-school' })
        });
        assert.equal(anotherTenant.status, 403);

        await fixture.pool.query(
            "ALTER TABLE local_events ADD CONSTRAINT ci_reject_student_event " +
            "CHECK (event_type <> 'student.created') NOT VALID"
        );
        constraintCreated = true;
        const failed = await api('/students', {
            method: 'POST', headers: adminHeaders, body: JSON.stringify(input)
        });
        assert.equal(failed.status, 500, JSON.stringify(failed.data));
        const persisted = await fixture.pool.query(
            'SELECT COUNT(*)::integer AS n FROM student WHERE tenant_code=$1 AND username=$2',
            [tenant, username]
        );
        assert.equal(persisted.rows[0].n, 0, 'Student row must roll back with failed event');
    } finally {
        if (constraintCreated) {
            await fixture.pool.query('ALTER TABLE local_events DROP CONSTRAINT ci_reject_student_event');
        }
        await fixture.pool.query('DELETE FROM "class" WHERE id=$1', [fixture.classId]);
        await fixture.pool.query('DELETE FROM grade WHERE id=$1', [fixture.gradeId]);
        if (priorFlag === undefined) delete process.env.TENANT_STUDENT_WRITES_ENABLED;
        else process.env.TENANT_STUDENT_WRITES_ENABLED = priorFlag;
    }
});
