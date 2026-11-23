import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { PoolClient } from 'pg';
import { createApp } from '../server';
import { runInTransaction, resolveTenantDatabaseUrl } from '../lib/db';
import { validateSubjectName } from '../services/subject.service';
import { readPage } from '../routes/subject.routes';

type ResponseSnapshot = { status: number; body: any; headers: Headers };
const adminTestKey = 'admin-development-only-secret-longer-than-thirty-two-bytes';
const agentTestKey = 'agent-development-only-secret-longer-than-thirty-two-bytes';

async function request(path: string, opts: RequestInit = {}): Promise<ResponseSnapshot> {
    const server = createApp('school-qa').listen(0, '127.0.0.1');
    try {
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Test listener unavailable');
        const res = await fetch('http://127.0.0.1:' + address.port + path, opts);
        const raw = await res.text();
        return { status: res.status, headers: res.headers, body: raw ? JSON.parse(raw) : null };
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close(error => error ? reject(error) : resolve())
        );
    }
}

async function withKeys(fn: () => Promise<void>, admin?: string, agent?: string) {
    const previousMode=process.env.TENANT_ADMIN_AUTH_MODE;
    const previousAllow=process.env.TENANT_ALLOW_DEV_API_KEY;
    const previousNodeEnv=process.env.NODE_ENV;
    process.env.TENANT_ADMIN_AUTH_MODE='legacy';
    process.env.TENANT_ALLOW_DEV_API_KEY='true';
    process.env.NODE_ENV='test';
    const priorAdmin = process.env.TENANT_ADMIN_API_KEY;
    const priorAgent = process.env.TENANT_AGENT_API_KEY;
    if (admin === undefined) delete process.env.TENANT_ADMIN_API_KEY;
    else process.env.TENANT_ADMIN_API_KEY = admin;
    if (agent === undefined) delete process.env.TENANT_AGENT_API_KEY;
    else process.env.TENANT_AGENT_API_KEY = agent;
    try { await fn(); }
    finally {
        if (priorAdmin === undefined) delete process.env.TENANT_ADMIN_API_KEY;
        else process.env.TENANT_ADMIN_API_KEY = priorAdmin;
        if (priorAgent === undefined) delete process.env.TENANT_AGENT_API_KEY;
        else process.env.TENANT_AGENT_API_KEY = priorAgent;
        if(previousMode===undefined)delete process.env.TENANT_ADMIN_AUTH_MODE;
        else process.env.TENANT_ADMIN_AUTH_MODE=previousMode;
        if(previousAllow===undefined)delete process.env.TENANT_ALLOW_DEV_API_KEY;
        else process.env.TENANT_ALLOW_DEV_API_KEY=previousAllow;
        if(previousNodeEnv===undefined)delete process.env.NODE_ENV;
        else process.env.NODE_ENV=previousNodeEnv;
    }
}

test('liveness is non-sensitive', async () => {
    const r = await request('/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: 'alive' });
    assert.equal(r.headers.get('x-powered-by'), null);
});

test('protected route fails closed if admin credential missing', async () => withKeys(async () => {
    const r = await request('/subjects');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'AUTH_NOT_CONFIGURED');
}));

test('admin credential does not unlock separate agent endpoint', async () => withKeys(async () => {
    const r = await request('/local-events/pending', {
        headers: { authorization: 'Bearer ' + adminTestKey }
    });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'AUTH_NOT_CONFIGURED');
}, adminTestKey));

test('invalid credential rejected without database connection', async () => withKeys(async () => {
    const r = await request('/subjects', {
        headers: { authorization: 'Bearer not-the-key' }
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'UNAUTHORIZED');
}, adminTestKey, agentTestKey));

test('spoofed tenant header rejected even with valid admin key', async () => withKeys(async () => {
    const r = await request('/subjects', {
        headers: { authorization: 'Bearer ' + adminTestKey, 'x-tenant-id': 'other-school' }
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'TENANT_HEADER_REJECTED');
}, adminTestKey));

test('cross-tenant subject create rejected before database query', async () => withKeys(async () => {
    const r = await request('/subjects', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + adminTestKey, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Mathematics', tenant_code: 'other-school' })
    });
    assert.equal(r.status, 403);
}, adminTestKey));

test('invalid pagination and invalid subject name rejected', async () => withKeys(async () => {
    const headers = { authorization: 'Bearer ' + adminTestKey, 'content-type': 'application/json' };
    const page = await request('/subjects?page=0&limit=1000', { headers });
    assert.equal(page.status, 400);
    const name = await request('/subjects', { method: 'POST', headers, body: JSON.stringify({ name: '' }) });
    assert.equal(name.status, 400);
}, adminTestKey));

test('unsafe legacy student/user routes cannot read sensitive records', async () => withKeys(async () => {
    const headers = { authorization: 'Bearer ' + adminTestKey };
    assert.equal((await request('/students', { headers })).status, 501);
    assert.equal((await request('/users', { headers })).status, 501);
}, adminTestKey));

test('input validation helpers reject out-of-bounds values', () => {
    assert.equal(validateSubjectName(''), false);
    assert.equal(validateSubjectName('x'.repeat(151)), false);
    assert.equal(validateSubjectName('Physics'), true);
    assert.equal(readPage({ page: '-1' }), null);
    assert.equal(readPage({ page: '1', limit: '101' }), null);
    assert.deepEqual(readPage({ page: '2', limit: '5' }), { page: 2, limit: 5, offset: 5 });
});

test('domain transaction commits only on successful write+outbox', async () => {
    const sql: string[] = [];
    const fake = { query: async (statement: string) => { sql.push(statement); return { rows: [] }; } } as unknown as PoolClient;
    const result = await runInTransaction(fake, async () => {
        await fake.query('INSERT DOMAIN');
        await fake.query('INSERT EVENT');
        return 7;
    });
    assert.equal(result, 7);
    assert.deepEqual(sql, ['BEGIN', 'INSERT DOMAIN', 'INSERT EVENT', 'COMMIT']);
});

test('domain transaction rolls back if event persistence fails', async () => {
    const sql: string[] = [];
    const fake = { query: async (statement: string) => {
        sql.push(statement);
        if (statement === 'INSERT EVENT') throw new Error('outbox insert failed');
        return { rows: [] };
    }} as unknown as PoolClient;
    await assert.rejects(() => runInTransaction(fake, async () => {
        await fake.query('INSERT DOMAIN');
        await fake.query('INSERT EVENT');
    }), /outbox insert failed/);
    assert.deepEqual(sql, ['BEGIN', 'INSERT DOMAIN', 'INSERT EVENT', 'ROLLBACK']);
});

test('legacy shared admin key can never be enabled in NODE_ENV=production',async()=>{
    const prev={mode:process.env.TENANT_ADMIN_AUTH_MODE,
        allow:process.env.TENANT_ALLOW_DEV_API_KEY,node:process.env.NODE_ENV,
        key:process.env.TENANT_ADMIN_API_KEY};
    process.env.TENANT_ADMIN_AUTH_MODE='legacy';
    process.env.TENANT_ALLOW_DEV_API_KEY='true';
    process.env.NODE_ENV='production';
    process.env.TENANT_ADMIN_API_KEY=adminTestKey;
    try {
        const r=await request('/students',{headers:{authorization:'Bearer '+adminTestKey}});
        assert.equal(r.status,503);
        assert.equal(r.body.code,'AUTH_NOT_CONFIGURED');
    }finally{
        const restore=(key:keyof typeof prev,envKey:string)=>{
            const value=prev[key];if(value===undefined)delete process.env[envKey];
            else process.env[envKey]=value;
        };
        restore('mode','TENANT_ADMIN_AUTH_MODE');
        restore('allow','TENANT_ALLOW_DEV_API_KEY');
        restore('node','NODE_ENV');
        restore('key','TENANT_ADMIN_API_KEY');
    }
});

test('database URL resolver forbids cross-tenant selection, unverified remote TLS and injection',()=>{
    const local='postgresql://qa_user:ci_password@127.0.0.1:5432/{tenant}';
    assert.equal(resolveTenantDatabaseUrl(local,'school-qa'),
        'postgresql://qa_user:ci_password@127.0.0.1:5432/school-qa');
    assert.throws(()=>resolveTenantDatabaseUrl(local,'../../postgres'),/Invalid configured tenant/);
    assert.throws(()=>resolveTenantDatabaseUrl(
        'postgresql://qa_user:ci_password@127.0.0.1:5432/postgres','school-qa'),/template|target/);
    assert.throws(()=>resolveTenantDatabaseUrl(
        'postgresql://qa_user:ci_password@db.example:5432/{tenant}','school-qa'),/verified TLS/);
    assert.throws(()=>resolveTenantDatabaseUrl(
        'postgresql://qa_user:ci_password@db.example:5432/{tenant}?sslmode=disable',
        'school-qa'),/verified TLS/);
    assert.throws(()=>resolveTenantDatabaseUrl(local+'?host=evil.example','school-qa'),
        /Unsafe PostgreSQL connection URL parameters/);
    assert.throws(()=>resolveTenantDatabaseUrl(local+'?sslmode=disable&sslmode=verify-full','school-qa'),
        /Unsafe PostgreSQL connection URL parameters/);
    const secure='postgresql://qa_user:ci_password@db.example:5432/{tenant}?sslmode=verify-full';
    assert.equal(resolveTenantDatabaseUrl(secure,'school-qa'),
        secure.replace('{tenant}','school-qa'));
});
