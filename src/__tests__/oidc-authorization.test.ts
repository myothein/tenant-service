import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../server';

test('real RS256 JWKS: enforce issuer, audience, role, tenant and expiry before Subject DB access',async()=>{
    const {publicKey,privateKey}=await generateKeyPair('RS256');
    const jwk=await exportJWK(publicKey);
    const key={...jwk,kid:'ci-rsa-key',use:'sig',alg:'RS256'};
    const jwks=createServer((req,res)=>{
        if(req.url!=='/jwks') {res.writeHead(404);res.end();return;}
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({keys:[key]}));
    });
    jwks.listen(0,'127.0.0.1');
    await once(jwks,'listening');
    const address=jwks.address();
    if(!address||typeof address==='string')throw Error('No JWKS port');
    const root='http://127.0.0.1:'+address.port;
    const issuer=root+'/realms/qa';
    const saved: Record<string,string|undefined>={};
    const values:Record<string,string>={
        TENANT_ADMIN_AUTH_MODE:'oidc',TENANT_OIDC_ISSUER:issuer,
        TENANT_OIDC_JWKS_URL:root+'/jwks',TENANT_OIDC_AUDIENCE:'tenant-service',
        TENANT_OIDC_REQUIRED_ROLE:'TENANT_ADMIN'
    };
    for(const [key,value] of Object.entries(values)){
        saved[key]=process.env[key];process.env[key]=value;
    }
    const app=createApp('school-qa');
    const listener=app.listen(0,'127.0.0.1');
    await once(listener,'listening');
    const a=listener.address();
    if(!a||typeof a==='string')throw Error('No API port');
    const url='http://127.0.0.1:'+a.port+'/students';
    const send=async(token:string)=>{
        const r=await fetch(url,{headers:{authorization:'Bearer '+token}});
        return {status:r.status,data:await r.json() as {code?:string}};
    };
    const sign=(claims:Record<string,unknown>,iss=issuer,aud='tenant-service',exp='5m')=>
        new SignJWT(claims)
            .setProtectedHeader({alg:'RS256',kid:'ci-rsa-key'})
            .setIssuedAt().setIssuer(iss).setAudience(aud)
            .setSubject('qa-admin').setExpirationTime(exp).sign(privateKey);
    try{
        const correct=await sign({tenant_id:'school-qa',realm_access:{roles:['TENANT_ADMIN']}});
        assert.equal((await send(correct)).status,501,'Authorized admin must pass auth middleware');
        const mismatch=await sign({tenant_id:'different-school',realm_access:{roles:['TENANT_ADMIN']}});
        assert.deepEqual(await send(mismatch),{status:403,data:{success:false,code:'TENANT_FORBIDDEN'}});
        const user=await sign({tenant_id:'school-qa',realm_access:{roles:['STUDENT']}});
        assert.deepEqual(await send(user),{status:403,data:{success:false,code:'ROLE_FORBIDDEN'}});
        assert.equal((await send(await sign({tenant_id:'school-qa',roles:['TENANT_ADMIN']},issuer,'other-api'))).status,401);
        assert.equal((await send(await sign({tenant_id:'school-qa',roles:['TENANT_ADMIN']},root+'/wrong'))).status,401);
        assert.equal((await send(await sign({tenant_id:'school-qa',roles:['TENANT_ADMIN']},issuer,'tenant-service','-10s'))).status,401);
        const token=(await send('opaque-legacy-api-key-never-a-valid-jwt'));
        assert.equal(token.status,401,'Shared API key cannot impersonate OIDC user');
    }finally{
        await new Promise<void>((resolve,reject)=>listener.close(e=>e?reject(e):resolve()));
        await new Promise<void>((resolve,reject)=>jwks.close(e=>e?reject(e):resolve()));
        for(const [key,value] of Object.entries(saved)){
            if(value===undefined)delete process.env[key];else process.env[key]=value;
        }
    }
});
test('OIDC configuration requires HTTPS for remote endpoints and matching origins',async()=>{
    const saved={mode:process.env.TENANT_ADMIN_AUTH_MODE,
        issuer:process.env.TENANT_OIDC_ISSUER,jwks:process.env.TENANT_OIDC_JWKS_URL,
        aud:process.env.TENANT_OIDC_AUDIENCE};
    process.env.TENANT_ADMIN_AUTH_MODE='oidc';
    process.env.TENANT_OIDC_ISSUER='http://remote.example/realms/qa';
    process.env.TENANT_OIDC_JWKS_URL='http://remote.example/certs';
    process.env.TENANT_OIDC_AUDIENCE='tenant-service';
    const server=createApp('school-qa').listen(0,'127.0.0.1');
    try {
        await once(server,'listening');
        const addr=server.address();
        if(!addr||typeof addr==='string')throw Error('No test port');
        const r=await fetch('http://127.0.0.1:'+addr.port+'/students',{
            headers:{authorization:'Bearer anything'}});
        assert.equal(r.status,503,'Public HTTP JWKS must be refused without network request');
    }finally{
        await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
        for(const [key,value] of Object.entries(saved)){
            const envKey={mode:'TENANT_ADMIN_AUTH_MODE',issuer:'TENANT_OIDC_ISSUER',
                jwks:'TENANT_OIDC_JWKS_URL',aud:'TENANT_OIDC_AUDIENCE'}[key as keyof typeof saved];
            if(value===undefined)delete process.env[envKey];else process.env[envKey]=value;
        }
    }
});
