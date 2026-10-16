import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteStore } from '../core/store.js';
import { createServices } from '../core/services.js';
import { config } from '../core/config.js';
import { createApp } from '../app.js';
import { bootstrapAdmin } from '../modules/auth.js';

const origin=new URL(config.appUrl).origin;
async function fixture(){const store=await createSqliteStore(':memory:');const services=createServices(store,{sendEmail:async()=>({id:'test-only'})});const app=createApp(services);const account=await bootstrapAdmin(store,{email:'admin@example.com',password:'Strong test password 123!',name:'Admin',publicationName:'Security Test'});return{store,services,app,account};}
async function login(app:ReturnType<typeof createApp>){const response=await app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({email:'admin@example.com',password:'Strong test password 123!'})});assert.equal(response.status,200);return response.headers.get('set-cookie')!.split(';')[0];}
function post(app:ReturnType<typeof createApp>,path:string,body:unknown,headers:Record<string,string>={}){return app.request(path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});}

test('Integrated app rejects cross-origin login, cookie writes and session logout',async t=>{const{store,app,account}=await fixture();t.after(()=>store.close());const crossLogin=await post(app,'/api/auth/login',{email:'admin@example.com',password:'Strong test password 123!'},{origin:'https://attacker.example'});assert.equal(crossLogin.status,403);assert.equal((await crossLogin.json()).error.code,'invalid_origin');assert.equal((await store.list('__system__','session')).items.length,0);
 const cookie=await login(app);for(const headers of [{cookie,origin:'https://attacker.example'},{cookie},{cookie,origin,'sec-fetch-site':'cross-site'}] as Record<string,string>[]){const response=await post(app,'/api/subscribers',{email:'blocked@example.com'},headers);assert.equal(response.status,403);assert.equal((await response.json()).error.code,'invalid_origin');}assert.equal((await store.list(account.tenantId,'subscriber')).items.length,0);assert.equal((await post(app,'/api/auth/logout',{}, {cookie,origin:'https://attacker.example'})).status,403);assert.equal((await app.request('/api/auth/me',{headers:{cookie}})).status,200);
 assert.equal((await post(app,'/api/subscribers',{email:'allowed@example.com'},{cookie,origin})).status,201);});

test('Origin bypass requires a valid scoped Bearer key; fake/revoked headers do not authenticate',async t=>{const{store,app}=await fixture();t.after(()=>store.close());const cookie=await login(app);const created=await post(app,'/api/api-keys',{name:'test key',scopes:['subscribers:read','subscribers:write']},{cookie,origin});assert.equal(created.status,201);const key=await created.json();const valid=await post(app,'/api/subscribers',{email:'key@example.com'},{authorization:'Bearer '+key.key,origin:'https://integration.example'});assert.equal(valid.status,201);
 const fake=await post(app,'/api/subscribers',{email:'fake@example.com'},{cookie,authorization:'Bearer invalid',origin:'https://attacker.example'});assert.equal(fake.status,403);assert.equal((await app.request('/api/subscribers',{headers:{authorization:'Bearer invalid'}})).status,401);
 const revoked=await app.request('/api/api-keys/'+key.id,{method:'DELETE',headers:{cookie,origin}});assert.equal(revoked.status,200);assert.equal((await post(app,'/api/subscribers',{email:'revoked@example.com'},{authorization:'Bearer '+key.key})).status,401);
});

test('Integrated app enforces scheduler credentials, JSON error boundaries, security headers and payload bounds',async t=>{const{store,app,services}=await fixture();t.after(()=>store.close());const previous=config.cronSecret;config.cronSecret='test-only-scheduler-secret';t.after(()=>{config.cronSecret=previous});let handled=0;services.registerJob('security-test',async()=>{handled++;});await services.enqueue({type:'security-test',tenantId:'test',payload:{}});
 assert.equal((await app.request('/api/jobs/run')).status,401);assert.equal((await app.request('/api/jobs/run',{headers:{authorization:'Bearer wrong'}})).status,401);assert.equal(handled,0);assert.equal((await app.request('/api/jobs/run',{headers:{authorization:'Bearer test-only-scheduler-secret'}})).status,200);assert.equal(handled,1);
 const cookie=await login(app);const invalid=await app.request('/api/subscribers',{method:'POST',headers:{'content-type':'application/json',cookie,origin},body:'{ invalid'});assert.equal(invalid.status,400);assert.equal((await invalid.json()).error.code,'invalid_json');assert.equal(invalid.headers.get('x-content-type-options'),'nosniff');assert.equal(invalid.headers.get('cache-control'),'no-store');assert.ok(invalid.headers.get('x-request-id'));
 const huge=await app.request('/api/subscribers',{method:'POST',headers:{'content-type':'application/json',cookie,origin},body:JSON.stringify({email:'x@example.com',name:'x'.repeat(5*1024*1024)})});assert.equal(huge.status,413);assert.equal((await app.request('/api/no-such-route')).status,404);
});
