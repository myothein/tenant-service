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
