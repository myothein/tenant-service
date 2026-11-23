import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createApp } from '../server';
import { runInTransaction, resolveTenantDatabaseUrl, assertRuntimeDbRole } from '../lib/db';
import { validateSubjectName } from '../services/subject.service';
import { readPage } from '../routes/subject.routes';
import { readUserPage } from '../routes/user.routes';
import { readStudentPage, readStudentId } from '../routes/student.routes';
import { validateStudentCreate, validateStudentRename } from '../services/student.service';

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

test('identical admin and agent machine credentials fail closed on both roles', async () => withKeys(async () => {
    const authorization = { authorization: 'Bearer ' + adminTestKey };
    const agentResponse = await request('/local-events/pending', { headers: authorization });
    assert.equal(agentResponse.status, 503);
    assert.equal(agentResponse.body.code, 'AUTH_NOT_CONFIGURED');
    const adminResponse = await request('/subjects', { headers: authorization });
    assert.equal(adminResponse.status, 503);
    assert.equal(adminResponse.body.code, 'AUTH_NOT_CONFIGURED');
}, adminTestKey, adminTestKey));

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

test('student writes remain disabled; tenant admin listings reject unbounded queries before DB access', async () => withKeys(async () => {
    const headers = { authorization: 'Bearer ' + adminTestKey };
    const invalidStudent = await request('/students?page=0&limit=500', { headers });
    assert.equal(invalidStudent.status, 400);
    assert.equal(invalidStudent.body.code, 'INVALID_PAGINATION');
    const malformedStudent = await request('/students/%20', { headers });
    assert.equal(malformedStudent.status, 400);
    assert.equal(malformedStudent.body.code, 'INVALID_STUDENT_ID');
    const deniedStudentWrite = await request('/students', { method: 'POST', headers });
    assert.equal(deniedStudentWrite.status, 405);
    assert.equal(deniedStudentWrite.body.code, 'STUDENT_WRITES_DISABLED');
    assert.equal(deniedStudentWrite.headers.get('allow'), 'GET, HEAD');
    const deniedStudentDelete = await request('/students/synthetic-id', { method: 'DELETE', headers });
    assert.equal(deniedStudentDelete.status, 405);
    const invalid = await request('/users?page=0&limit=500', { headers });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'INVALID_PAGINATION');
    for (const route of ['/students?limit=1','/users?limit=1']) {
        const spoof = await request(route, { headers: { ...headers, 'x-tenant-id': 'another-school' } });
        assert.equal(spoof.status, 403);
    }
}, adminTestKey));

test('student write opt-in rejects invalid bodies and cross-tenant intent before DB access', async () => withKeys(async () => {
    const before = process.env.TENANT_STUDENT_WRITES_ENABLED;
    process.env.TENANT_STUDENT_WRITES_ENABLED = 'true';
    const headers = {
        authorization: 'Bearer ' + adminTestKey, 'content-type': 'application/json',
        'Idempotency-Key': randomUUID()
    };
    try {
        const missing = await request('/students', {
            method: 'POST', headers: { authorization: 'Bearer ' + adminTestKey }
        });
        assert.equal(missing.status, 428);
        assert.equal(missing.body.code, 'IDEMPOTENCY_KEY_REQUIRED');
        const malformed = await request('/students', {
            method: 'POST', headers: { ...headers, 'Idempotency-Key': 'aaaaaaaaaaaaaaaa' }
        });
        assert.equal(malformed.status, 400);
        assert.equal(malformed.body.code, 'INVALID_IDEMPOTENCY_KEY');
        const empty = await request('/students', {
            method: 'POST', headers, body: JSON.stringify({ name: 'Synthetic' })
        });
        assert.equal(empty.status, 400);
        assert.equal(empty.body.code, 'INVALID_STUDENT_INPUT');

        const crossTenant = await request('/students', {
            method: 'POST', headers, body: JSON.stringify({ tenant_code: 'other-school' })
        });
        assert.equal(crossTenant.status, 403);
        assert.equal(crossTenant.body.code, 'TENANT_FORBIDDEN');

        const invalidEdit = await request('/students/test-id', {
            method: 'PUT', headers, body: JSON.stringify({ name: 'Synthetic', surname: 'QA', email: 'not-allowed' })
        });
        assert.equal(invalidEdit.status, 400);
        assert.equal(invalidEdit.body.code, 'INVALID_STUDENT_INPUT');

        const crossEdit = await request('/students/test-id', {
            method: 'PUT', headers,
            body: JSON.stringify({ tenant_code: 'different-school', name: 'Synthetic', surname: 'QA' })
        });
        assert.equal(crossEdit.status, 403);

        const crossDelete = await request('/students/test-id', {
            method: 'DELETE', headers, body: JSON.stringify({ tenant_code: 'different-school' })
        });
        assert.equal(crossDelete.status, 403);
    } finally {
        if (before === undefined) delete process.env.TENANT_STUDENT_WRITES_ENABLED;
        else process.env.TENANT_STUDENT_WRITES_ENABLED = before;
    }
}, adminTestKey, agentTestKey));

test('student write payload validator disallows unknown fields, invalid class and medical values', () => {
    const synthetic = {
        username: 'ci_student', name: 'Synthetic', surname: 'QA', address: 'synthetic',
        bloodType: 'O_POS', sex: 'MALE', birthday: '2001-01-01', classId: 1, gradeId: 1
    };
    assert.deepEqual(validateStudentCreate(synthetic), { ...synthetic, email: null, phone: null });
    for (const invalid of [
        { ...synthetic, tenant_code: 'other-school', password: 'not-accepted' },
        { ...synthetic, bloodType: 'NOT_VALID' },
        { ...synthetic, sex: 'UNKNOWN' },
        { ...synthetic, classId: 0 },
        { ...synthetic, gradeId: -1 },
        { ...synthetic, birthday: '2099-01-01' },
        { ...synthetic, birthday: '2026-02-31' },
        { ...synthetic, address: '' },
        { ...synthetic, name: '\n' },
        { ...synthetic, username: '../root' }
    ]) {
        assert.equal(validateStudentCreate(invalid), null);
    }
    assert.deepEqual(validateStudentRename({name:'Synthetic',surname:'QA'}),
        {name:'Synthetic',surname:'QA'});
    assert.equal(validateStudentRename({name:'Synthetic',surname:'QA',bloodType:'A_POS'}), null);
});

test('student directory requires valid admin role before connecting to tenant DB', async () => withKeys(async () => {
    const denied = await request('/students?page=0', {
        headers: { authorization: 'Bearer invalid-credential' }
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.body.code, 'UNAUTHORIZED');
}, adminTestKey, agentTestKey));

test('student directory pagination and identifiers are strictly bounded', () => {
    assert.deepEqual(readStudentPage({}), { page: 1, limit: 20, offset: 0 });
    assert.deepEqual(readStudentPage({ page: '3', limit: '5' }), { page: 3, limit: 5, offset: 10 });
    for (const query of [{page:'0'}, {page:'-1'}, {page:'1.1'}, {limit:'101'},
        {limit:'0'}, {limit:'1;SELECT'}, {page:['1','2']}, {page:'9999999999'}]) {
        assert.equal(readStudentPage(query), null);
    }
    assert.equal(readStudentId('student_qa-01'), 'student_qa-01');
    for (const id of ['', '../other', 'bad id', 'x'.repeat(129), undefined, ['a']]) {
        assert.equal(readStudentId(id), null);
    }
});

test('user directory requires admin authorization before any database query', async () => withKeys(async () => {
    const unauthorized = await request('/users?limit=5', {
        headers: { authorization: 'Bearer invalid-credential' }
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.code, 'UNAUTHORIZED');
}, adminTestKey, agentTestKey));

test('user directory pagination is bounded and rejects ambiguous query types', () => {
    assert.deepEqual(readUserPage({}), { page: 1, limit: 20, offset: 0 });
    assert.deepEqual(readUserPage({ page: '3', limit: '5' }), { page: 3, limit: 5, offset: 10 });
    for (const query of [{page:'0'},{page:'-1'},{page:'1.1'}, {limit:'101'},
        {limit:'0'}, {limit:'1;SELECT'}, {page: ['1', '2']}, {page:'9999999999'}]) {
        assert.equal(readUserPage(query), null);
    }
});

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

test('production DB runtime guard rejects privileged DB roles before domain queries',async()=>{
    const original={env:process.env.NODE_ENV, role:process.env.TENANT_DB_EXPECTED_ROLE};
    process.env.NODE_ENV='production';
    process.env.TENANT_DB_EXPECTED_ROLE='qa_runtime';
    const fake={
        query:async()=>({rows:[{role_name:'qa_runtime',rolsuper:true,rolcreatedb:false,
            rolcreaterole:false,rolreplication:false,rolbypassrls:false}]})
    } as unknown as Pick<PoolClient,'query'>;
    try {
        await assert.rejects(()=>assertRuntimeDbRole(fake),/unsafe privileges/);
    }finally{
        if(original.env===undefined)delete process.env.NODE_ENV;
        else process.env.NODE_ENV=original.env;
        if(original.role===undefined)delete process.env.TENANT_DB_EXPECTED_ROLE;
        else process.env.TENANT_DB_EXPECTED_ROLE=original.role;
    }
});
