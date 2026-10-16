import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteStore } from '../core/store.js';
import { createServices } from '../core/services.js';
import { ApiError } from '../core/http.js';
import { rateLimit } from '../core/security.js';
import type { Stored } from '../contracts.js';

const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

test('Store isolates tenant/kind keys, supports typed filters, and returns stable cursor pages',async t=>{
 const store=await createSqliteStore(':memory:');t.after(()=>store.close());
 for(let index=0;index<7;index++)await store.insert('tenant-a','record',{index,enabled:index%2===0,category:index<3?'small':'large',optional:index===0?null:'set',custom:{team:'Design'}},'r'+index);
 await store.insert('tenant-b','record',{index:99,enabled:true},'r0');await store.insert('tenant-a','different',{index:88,enabled:true},'r0');
 assert.equal((await store.get('tenant-a','record','r0'))!.data.index,0);assert.equal((await store.get('tenant-b','record','r0'))!.data.index,99);
 assert.equal((await store.list('tenant-a','record',{filters:{enabled:true}})).items.length,4);assert.equal((await store.list('tenant-a','record',{filters:{enabled:false}})).items.length,3);
 assert.equal((await store.list('tenant-a','record',{filters:{index:3}})).items[0].id,'r3');assert.equal((await store.list('tenant-a','record',{filters:{optional:null}})).items.length,1);assert.equal((await store.list('tenant-a','record',{filters:{'custom.team':'Design'}})).items.length,7);
 for(const order of ['asc','desc'] as const){let cursor:string|undefined;const collected:string[]=[];do{const page=await store.list('tenant-a','record',{limit:2,cursor,order});collected.push(...page.items.map(record=>record.id));cursor=page.nextCursor||undefined;}while(cursor);assert.equal(collected.length,7);assert.equal(new Set(collected).size,7);}
 await assert.rejects(store.list('tenant-a','record',{cursor:'not-a-valid-cursor'}),e=>e instanceof ApiError&&e.status===400);
 await assert.rejects(store.list('tenant-a','record',{filters:{"email') OR 1=1 --":'x'}}),e=>e instanceof ApiError&&e.status===400);
 const escaped="x' OR 1=1 --";await store.insert('tenant-a','record',{email:escaped},'safe-sql');assert.deepEqual((await store.list('tenant-a','record',{filters:{email:escaped}})).items.map(r=>r.id),['safe-sql']);
});

test('Store rolls back writes and nested enqueue on transaction failure',async t=>{
 const store=await createSqliteStore(':memory:');t.after(()=>store.close());const services=createServices(store);
 await assert.rejects(store.transaction(async tx=>{await tx.insert('tenant-a','record',{value:1},'rollback');await services.enqueue({type:'test',tenantId:'tenant-a',payload:{},idempotencyKey:'rollback'},tx);throw new Error('abort');}),/abort/);
 assert.equal(await store.get('tenant-a','record','rollback'),null);assert.equal((await store.list('__jobs__','job')).items.length,0);
 await assert.rejects(store.lock('outside-transaction'),/transaction/);
});

test('Store optimistic versioning permits one concurrent update and prevents stale deletion',async t=>{
 const store=await createSqliteStore(':memory:');t.after(()=>store.close());const row=await store.insert('tenant-a','record',{counter:0});
 const results=await Promise.allSettled([store.update('tenant-a','record',row.id,{counter:1},row.version),store.update('tenant-a','record',row.id,{counter:2},row.version)]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected'&&result.reason instanceof ApiError&&result.reason.status===409).length,1);
 await assert.rejects(store.remove('tenant-a','record',row.id,row.version),e=>e instanceof ApiError&&e.status===409);assert.ok(await store.get('tenant-a','record',row.id));assert.equal(await store.remove('tenant-b','record',row.id),false);
});

test('Transactional locks serialize read-modify-write updates',async t=>{
 const store=await createSqliteStore(':memory:');t.after(()=>store.close());await store.insert('tenant-a','counter',{value:0},'counter');
 await Promise.all(Array.from({length:12},()=>store.transaction(async tx=>{await tx.lock('counter:tenant-a');const current=(await tx.get('tenant-a','counter','counter'))!;await tx.update('tenant-a','counter','counter',{value:current.data.value+1},current.version);})));assert.equal((await store.get('tenant-a','counter','counter'))!.data.value,12);
});

test('Durable queue idempotency includes both tenant and job type',async t=>{
 const store=await createSqliteStore(':memory:');t.after(()=>store.close());const services=createServices(store);
 const same=await Promise.all(Array.from({length:10},()=>services.enqueue({type:'work',tenantId:'tenant-a',payload:{value:1},idempotencyKey:'same'})));assert.equal(new Set(same.map(job=>job.id)).size,1);
 const tenant=await services.enqueue({type:'work',tenantId:'tenant-b',payload:{},idempotencyKey:'same'});const type=await services.enqueue({type:'other',tenantId:'tenant-a',payload:{},idempotencyKey:'same'});assert.notEqual(tenant.id,same[0].id);assert.notEqual(type.id,same[0].id);assert.equal((await store.list('__jobs__','job')).items.length,3);
});

test('Concurrent workers claim each job only once and preserve actual tenant context',async t=>{
 const store=await createSqliteStore(':memory:');t.after(()=>store.close());const first=createServices(store),second=createServices(store);const observed:Record<string,number>={};
 const handler=async(job:Stored)=>{assert.equal(job.tenantId,'tenant-a');observed[job.id]=(observed[job.id]||0)+1;await pause(4);};first.registerJob('work',handler);second.registerJob('work',handler);
 for(let index=0;index<12;index++)await first.enqueue({type:'work',tenantId:'tenant-a',payload:{index},idempotencyKey:String(index)});
 await Promise.all([first.runJobs(20),second.runJobs(20)]);assert.equal(Object.keys(observed).length,12);assert.ok(Object.values(observed).every(count=>count===1));assert.equal((await store.list('__jobs__','job',{filters:{status:'completed'}})).items.length,12);assert.equal((await first.runJobs()).processed,0);
});

test('Queue retries transient failures durably, honors delayed execution, and stops at retry limit',async t=>{
 const store=await createSqliteStore(':memory:');t.after(()=>store.close());const services=createServices(store);let attempts=0;services.registerJob('transient',async()=>{attempts++;if(attempts===1)throw new Error('temporary failure');});
 const job=await services.enqueue({type:'transient',tenantId:'tenant-a',payload:{},maxAttempts:3});const first=await services.runJobs();assert.equal(first.failed,1);let stored=(await store.get('__jobs__','job',job.id))!;assert.equal(stored.data.status,'queued');assert.equal(stored.data.attempts,1);assert.ok(Date.parse(stored.data.runAt)>Date.now());assert.equal((await services.runJobs()).processed,0);
 await store.update('__jobs__','job',stored.id,{...stored.data,runAt:new Date(Date.now()-1000).toISOString()},stored.version);assert.equal((await services.runJobs()).failed,0);assert.equal((await store.get('__jobs__','job',job.id))!.data.status,'completed');assert.equal(attempts,2);
 services.registerJob('exhaust',async()=>{throw new Error('still unavailable');});const exhausted=await services.enqueue({type:'exhaust',tenantId:'tenant-a',payload:{},maxAttempts:1});await services.runJobs();assert.equal((await store.get('__jobs__','job',exhausted.id))!.data.status,'failed');
});

test('Queue permanent errors fail immediately and expired leases are recoverable',async t=>{
 const store=await createSqliteStore(':memory:');t.after(()=>store.close());const services=createServices(store);services.registerJob('invalid',async()=>{throw new ApiError(422,'invalid','Not retryable');});const bad=await services.enqueue({type:'invalid',tenantId:'tenant-a',payload:{},maxAttempts:100});await services.runJobs();assert.equal((await store.get('__jobs__','job',bad.id))!.data.status,'failed');
 let invoked=0;services.registerJob('recover',async()=>{invoked++;});const job=await services.enqueue({type:'recover',tenantId:'tenant-a',payload:{}});await store.update('__jobs__','job',job.id,{...job.data,status:'running',leaseUntil:new Date(Date.now()-1000).toISOString(),leaseOwner:'old-worker'},job.version);await services.runJobs();assert.equal(invoked,1);assert.equal((await store.get('__jobs__','job',job.id))!.data.status,'completed');
});

test('Event emission schedules only enabled matching webhook endpoints and rolls back atomically',async t=>{
 const store=await createSqliteStore(':memory:');t.after(()=>store.close());const services=createServices(store);
 await store.insert('tenant-a','webhook_endpoint',{enabled:true,events:['subscriber.created']},'matching');await store.insert('tenant-a','webhook_endpoint',{enabled:true,events:['*']},'all');await store.insert('tenant-a','webhook_endpoint',{enabled:false,events:['*']},'disabled');await store.insert('tenant-a','webhook_endpoint',{enabled:true,events:['post.sent']},'other');await store.insert('tenant-b','webhook_endpoint',{enabled:true,events:['*']},'tenant-other');
 await store.transaction(tx=>services.emit('tenant-a','subscriber.created',{subscriberId:'s1'},tx));const jobs=(await store.list('__jobs__','job')).items;assert.equal(jobs.length,2);assert.deepEqual(new Set(jobs.map(job=>job.data.payload.endpointId)),new Set(['matching','all']));
 await assert.rejects(store.transaction(async tx=>{await services.emit('tenant-a','subscriber.created',{subscriberId:'s2'},tx);throw Error('abort');}));assert.equal((await store.list('__jobs__','job')).items.length,2);assert.equal((await store.list('tenant-a','event')).items.length,1);
});

test('Rate limits remain atomic under concurrent requests and isolate unrelated keys',async t=>{
 const store=await createSqliteStore(':memory:');t.after(()=>store.close());const services=createServices(store);const results=await Promise.allSettled(Array.from({length:10},()=>rateLimit(services,'signup:test',3,3600)));assert.equal(results.filter(result=>result.status==='fulfilled').length,3);assert.ok(results.filter(result=>result.status==='rejected').every(result=>result.status==='rejected'&&result.reason instanceof ApiError&&result.reason.status===429));await rateLimit(services,'signup:other',3,3600);
});

test('Rate-limit buckets reset without accumulating one record per window',async t=>{const store=await createSqliteStore(':memory:');t.after(()=>store.close());const services=createServices(store);let time=Date.now();t.mock.method(Date,'now',()=>time);await rateLimit(services,'stable-rate-key',1,60);await assert.rejects(rateLimit(services,'stable-rate-key',1,60),e=>e instanceof ApiError&&e.status===429);time+=61000;await rateLimit(services,'stable-rate-key',1,60);await assert.rejects(rateLimit(services,'stable-rate-key',1,60),e=>e instanceof ApiError&&e.status===429);assert.equal((await store.list('__system__','rate_limit')).items.length,1);});
