import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createPostgresStore } from '../core/store.js';
import { createServices } from '../core/services.js';
import { ApiError } from '../core/http.js';
import { authenticate, bootstrapAdmin, registerAuth } from '../modules/auth.js';
import type { Api, Variables } from '../contracts.js';

const connection=process.env.TEST_DATABASE_URL;
test('PostgreSQL production adapter: filters, cursor, transactions, CAS, cross-pool locks, durable queue and authentication',{skip:!connection},async t=>{
 const [first,second]=await Promise.all([createPostgresStore(connection!),createPostgresStore(connection!)]);t.after(async()=>{await first.close();await second.close();});const tenant='pg-test-'+randomUUID();
 await t.test('JSONB filters, normalized parameters, cursor ordering and tenant isolation',async()=>{
  for(let n=0;n<7;n++)await first.insert(tenant,'record',{n,enabled:n%2===0,field:n===0?null:'present',nested:{label:'match'}},'r'+n);
  await first.insert(tenant+'-other','record',{n:99},'r0');assert.equal((await first.get(tenant,'record','r0'))!.data.n,0);assert.equal((await first.get(tenant+'-other','record','r0'))!.data.n,99);
  assert.equal((await first.list(tenant,'record',{filters:{enabled:true}})).items.length,4);assert.equal((await first.list(tenant,'record',{filters:{enabled:false}})).items.length,3);assert.equal((await first.list(tenant,'record',{filters:{n:3}})).items[0].id,'r3');assert.equal((await first.list(tenant,'record',{filters:{field:null}})).items.length,1);assert.equal((await first.list(tenant,'record',{filters:{'nested.label':'match'}})).items.length,7);
  for(const order of ['asc','desc'] as const){let cursor:string|undefined;const collected:string[]=[];do{const page=await first.list(tenant,'record',{limit:2,cursor,order});collected.push(...page.items.map(row=>row.id));cursor=page.nextCursor||undefined;}while(cursor);assert.equal(collected.length,7);assert.equal(new Set(collected).size,7);}
  const injection="' OR 1=1 --";await first.insert(tenant,'record',{email:injection},'injection');assert.equal((await first.list(tenant,'record',{filters:{email:injection}})).items[0].id,'injection');
 });
 await t.test('Concurrent CAS and transaction rollback',async()=>{
  const record=await first.insert(tenant,'cas',{value:0});const outcomes=await Promise.allSettled([first.update(tenant,'cas',record.id,{value:1},record.version),second.update(tenant,'cas',record.id,{value:2},record.version)]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.ok(outcomes.some(r=>r.status==='rejected'&&r.reason instanceof ApiError&&r.reason.status===409));
  await assert.rejects(first.transaction(async tx=>{await tx.insert(tenant,'rollback',{value:1},'row');throw Error('abort');}),/abort/);assert.equal(await second.get(tenant,'rollback','row'),null);
 });
 await t.test('PostgreSQL advisory locks serialize across independent connection pools',async()=>{
  await first.insert(tenant,'counter',{value:0},'one');await Promise.all(Array.from({length:20},(_,n)=>(n%2?first:second).transaction(async tx=>{await tx.lock('counter:'+tenant);const row=(await tx.get(tenant,'counter','one'))!;await tx.update(tenant,'counter',row.id,{value:row.data.value+1},row.version);})));assert.equal((await first.get(tenant,'counter','one'))!.data.value,20);
 });
 await t.test('Queue idempotency and claiming remain atomic across pools',async()=>{
  const servicesA=createServices(first),servicesB=createServices(second);const type='pg-work-'+randomUUID();const calls:Record<string,number>={};const handler=async(job:{id:string;tenantId:string})=>{assert.equal(job.tenantId,tenant);calls[job.id]=(calls[job.id]||0)+1;await new Promise<void>(resolve=>setTimeout(resolve,5));};servicesA.registerJob(type,handler);servicesB.registerJob(type,handler);
  const duplicates=await Promise.all(Array.from({length:8},(_,n)=>(n%2?servicesA:servicesB).enqueue({type,tenantId:tenant,payload:{},idempotencyKey:'same'})));assert.equal(new Set(duplicates.map(row=>row.id)).size,1);for(let n=0;n<5;n++)await servicesA.enqueue({type,tenantId:tenant,payload:{},idempotencyKey:'additional-'+n});await Promise.all([servicesA.runJobs(20),servicesB.runJobs(20)]);assert.equal(Object.keys(calls).length,6);assert.ok(Object.values(calls).every(count=>count===1));
  await assert.rejects(first.transaction(async tx=>{await servicesA.enqueue({type,tenantId:tenant,payload:{},idempotencyKey:'rollback'},tx);throw Error('rollback');}));assert.equal((await first.list('__jobs__','job',{filters:{type,tenantId:tenant}})).items.length,6);
 });
 await t.test('Account bootstrap is atomic and sessions work through actual SQL storage',async()=>{
  const email=`pg-${randomUUID()}@example.com`;const input={email,password:'Postgres test password 123!',name:'Postgres Admin',publicationName:'Postgres test'};
  const results=await Promise.allSettled([bootstrapAdmin(first,input),bootstrapAdmin(second,input)]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.ok(results.some(result=>result.status==='rejected'&&result.reason instanceof ApiError&&result.reason.status===409));
  const services=createServices(first,{sendEmail:async()=>({id:'test-only'})});const app:Api=new Hono<{Variables:Variables}>();app.onError((error,c)=>c.json({code:error instanceof ApiError?error.code:'internal'},(error instanceof ApiError?error.status:500) as 400));app.use('*',authenticate(services));registerAuth(app,services);
  const response=await app.request('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:input.password})});assert.equal(response.status,200);const cookie=response.headers.get('set-cookie')!.split(';')[0];const account=await response.json();assert.equal(account.user.email,email);const me=await app.request('/auth/me',{headers:{cookie}});assert.equal(me.status,200);const logout=await app.request('/auth/logout',{method:'POST',headers:{cookie}});assert.equal(logout.status,200);assert.equal((await app.request('/auth/me',{headers:{cookie}})).status,401);
 });
});
