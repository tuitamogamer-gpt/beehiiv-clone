import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { rm } from 'node:fs/promises';
import { createSqliteStore } from '../core/store.js';
import { createServices } from '../core/services.js';
import { config } from '../core/config.js';
import { createApp } from '../app.js';
import { bootstrapAdmin } from '../modules/auth.js';

async function fixture(){
 const store=await createSqliteStore();const services=createServices(store);const app=createApp(services);
 const owner=await bootstrapAdmin(store,{email:'app-test@example.com',password:'test-password-123456',name:'Test Owner',publicationName:'Integration Test'});
 const response=await app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:new URL(config.appUrl).origin},body:JSON.stringify({email:'app-test@example.com',password:'test-password-123456'})});
 assert.equal(response.status,200);const cookie=response.headers.get('set-cookie')!.split(';')[0];
 const request=(path:string,method='GET',body?:unknown,extra:Record<string,string>={})=>app.request('/api'+path,{method,headers:{cookie,origin:new URL(config.appUrl).origin,'content-type':'application/json',...extra},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 return{store,services,app,owner,cookie,request};
}

test('integrated API protects sessions, publication evidence, scopes and empty real workspace',async()=>{
 const f=await fixture();try{
  assert.equal((await f.app.request('/api/status')).status,200);
  assert.equal((await f.app.request('/api/workspace')).status,401);
  const workspace=await(await f.request('/workspace')).json();assert.equal(workspace.data.posts.length,0);assert.equal(workspace.data.subscribers.length,0);assert.equal(workspace.data.publication.name,'Integration Test');
  const bad=await f.request('/publication','PATCH',{name:'Attacker',version:1},{origin:'https://evil.example'});assert.equal(bad.status,403);
  const noOrigin=await f.app.request('/api/publication',{method:'PATCH',headers:{cookie:f.cookie,'content-type':'application/json'},body:JSON.stringify({name:'Attacker',version:1})});assert.equal(noOrigin.status,403);
  assert.equal((await f.request('/publication','PATCH',{verifiedDomain:{status:'verified'},version:1})).status,422);
  assert.equal((await f.request('/publication','PATCH',{name:'Saved Publication',version:1})).status,200);
  assert.equal((await f.request('/publication','PATCH',{name:'Stale',version:1})).status,409);
  const key=await(await f.request('/api-keys','POST',{name:'Workspace only',scopes:['workspace:read']})).json();
  assert.equal((await f.app.request('/api/workspace',{headers:{authorization:`Bearer ${key.key}`}})).status,403);
  assert.equal((await f.app.request('/api/subscribers',{headers:{authorization:`Bearer ${key.key}`}})).status,403);
  const error=await(await f.app.request('/api/not-a-route')).json();assert.equal(error.error.code,'not_found');
 }finally{await f.store.close();}
});

test('integrated scheduler requires its own secret and executes registered durable jobs',async()=>{
 const f=await fixture(),old=config.cronSecret;config.cronSecret='test-cron-secret-with-sufficient-entropy';try{
  assert.equal((await f.request('/jobs/run','POST')).status,401);assert.equal((await f.app.request('/api/jobs/run',{headers:{authorization:'Bearer wrong'}})).status,401);
  let called=0;f.services.registerJob('test.run',async()=>{called++;});await f.services.enqueue({tenantId:f.owner.tenantId,type:'test.run',payload:{},idempotencyKey:'one'});
  const result=await f.app.request('/api/jobs/run',{headers:{authorization:`Bearer ${config.cronSecret}`}});assert.equal(result.status,200);assert.equal(called,1);
  await f.app.request('/api/jobs/run',{headers:{authorization:`Bearer ${config.cronSecret}`}});assert.equal(called,1);
 }finally{config.cronSecret=old;await f.store.close();}
});

test('private media is optimized, tenant owned, excludes active formats and survives storage retrieval',async()=>{
 const f=await fixture();try{
  const bytes=await sharp({create:{width:3000,height:500,channels:3,background:'#ec73a4'}}).png().toBuffer();const form=new FormData();form.set('file',new File([bytes],'image.png',{type:'image/png'}));
  const response=await f.app.request('/api/media',{method:'POST',headers:{cookie:f.cookie,origin:new URL(config.appUrl).origin},body:form});assert.equal(response.status,201);const media=await response.json();assert.equal(media.mimeType,'image/webp');assert.equal(media.width,1920);
  assert.equal((await f.app.request(`/api/media/${media.id}/content`)).status,401);const content=await f.request(`/media/${media.id}/content`);assert.equal(content.status,200);assert.equal(content.headers.get('content-type'),'image/webp');assert.equal((await sharp(Buffer.from(await content.arrayBuffer())).metadata()).width,1920);
  const dangerous=new FormData();dangerous.set('file',new File(['<svg onload="alert(1)"/>'],'evil.svg',{type:'image/svg+xml'}));assert.equal((await f.app.request('/api/media',{method:'POST',headers:{cookie:f.cookie,origin:new URL(config.appUrl).origin},body:dangerous})).status,422);
  assert.equal((await f.request(`/media/${media.id}`,'DELETE')).status,204);assert.equal((await f.request(`/media/${media.id}/content`)).status,404);
 }finally{await rm(`.data/media/${f.owner.tenantId}`,{recursive:true,force:true});await f.store.close();}
});
