import test from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {Webhook} from 'svix';
import type {Api, EmailMessage, Services, Stored, Variables} from '../contracts.js';
import {createSqliteStore} from '../core/store.js';
import {createServices} from '../core/services.js';
import {config} from '../core/config.js';
import {ApiError, hash} from '../core/http.js';
import {addSuppression, assertSenderReady, classifyBounce, createPost, createUnsubscribeLink, deliveryEligibility, isKnownBotClick, refreshPostMetrics, registerDelivery, registerProviderMessage, schedulePost, updatePost, verifyResendWebhook} from '../modules/delivery.js';
import {renderPost, sanitizePostHtml} from '../modules/email-renderer.js';

const secret=`whsec_${Buffer.from('delivery-test-signing-secret-32bytes').toString('base64')}`;
config.resendApiKey='test_provider_key';config.resendWebhookSecret=secret;config.sessionSecret='test-session-secret-with-at-least-32-bytes';config.appUrl='https://newsletter.test';
const stamp=()=>new Date().toISOString();
async function setup(t:any,transport?:(message:EmailMessage)=>Promise<{id:string}>){
  const store=await createSqliteStore(':memory:');t.after(()=>store.close());const sent:EmailMessage[]=[];
  const services=createServices(store,{sendEmail:transport|| (async message=>{sent.push(message);return {id:`provider-${sent.length}`};})});
  await store.insert('tenant-a','publication',{name:'Real Publication',sender:'hello@example.com',domain:'example.com',slug:'real-publication',accent:'#ed70a1',verifiedDomain:{domain:'example.com',provider:'resend',providerDomainId:'domain-test-id',status:'verified',verifiedAt:stamp(),alignedSender:true,ownershipVerified:true,dkim:'verified',spf:'verified',dmarc:'configured'}},'publication-a');
  await store.insert('__system__','tenant',{tenantId:'tenant-a',slug:'real-publication'},'tenant-a');
  const app=new Hono<{Variables:Variables}>().basePath('/api');
  app.use('*',async(c,next)=>{const tenant=c.req.header('x-test-tenant');if(tenant)c.set('principal',{tenantId:tenant,userId:'test-user',role:(c.req.header('x-test-role')||'admin') as any,...(c.req.header('x-test-key')?{apiKeyId:'key',scopes:(c.req.header('x-test-scopes')||'').split(',')}: {})});await next();});
  app.onError((error,c)=>c.json({code:(error as ApiError).code||'error',message:error.message},(error as ApiError).status as any||500));registerDelivery(app as Api,services);
  const request=(path:string,options:RequestInit={},authenticated=true)=>app.request(`https://newsletter.test/api${path}`,{...options,headers:{...(authenticated?{'x-test-tenant':'tenant-a'}:{}),...options.headers}});
  const subscriber=async(id='subscriber-a',email='reader@example.net',extra:Record<string,unknown>={})=>store.insert('tenant-a','subscriber',{name:'Olivia Reader',email,status:'Active',tier:'Free',source:'Website',joined:stamp(),...extra},id);
  const post=()=>createPost(services,'tenant-a',{title:'Subject A',subtitle:'A real message',content:'<p>Hello {{first_name}}</p><p>Free article</p><!-- paywall --><p>PREMIUM SECRET</p>',subjectB:'Subject B'});
  const drain=async()=>{for(let index=0;index<6;index++)await services.runJobs(100);};
  return {store,services,app,request,subscriber,post,drain,sent};
}
const sign=(body:string,eventId='event-one',date=new Date())=>({'svix-id':eventId,'svix-timestamp':String(Math.floor(date.getTime()/1000)),'svix-signature':new Webhook(secret).sign(eventId,date,body),'Content-Type':'application/json'});
const handlerJob=(tenantId:string,payload:Record<string,unknown>):Stored=>({id:'direct-test-job',tenantId,kind:'job',data:{payload,attempts:1},version:1,createdAt:stamp(),updatedAt:stamp()});

test('renderer removes execution vectors, personalizes safely, and gates free content',()=>{
  const source='<p>Hello {{first_name}}</p><script>alert(1)</script><img src="https://example.com/a.jpg" onerror="evil()"><a href="javascript:alert(1)">bad</a><p class="other premium-divider">Premium</p><p>paid-secret</p><audio src="https://example.com/audio.mp3"></audio>';
  const saved=sanitizePostHtml(source);assert.doesNotMatch(saved,/<script|onerror|javascript:/i);assert.match(saved,/premium-divider/);
  const input={post:{title:'Hello {{first_name}}',content:saved},publication:{name:'The Brief'},subscriber:{name:'<img src=x onerror=evil()>',email:'r@example.com'}};
  const free=renderPost({...input,channel:'email',tier:'Free',unsubscribeUrl:'https://newsletter.test/unsubscribe'});assert.doesNotMatch(free.html,/paid-secret|<audio|<script|onerror="/);assert.match(free.html,/&lt;img/);assert.match(free.html,/role="presentation"/);assert.match(free.html,/List|Unsubscribe/);assert.equal(free.bytes,Buffer.byteLength(free.html));
  const premium=renderPost({...input,channel:'web',tier:'Premium'});assert.match(premium.html,/paid-secret/);assert.match(premium.html,/<audio/);
});

test('bounce taxonomy preserves mailbox full and DNS retry semantics',()=>{
  assert.deepEqual(classifyBounce('550 5.1.1 user unknown'),{kind:'hard',retry:false,permanent:true});
  assert.equal(classifyBounce({type:'Permanent',message:'Mailbox full 5.2.2'}).kind,'mailbox_full');
  assert.equal(classifyBounce('EAI_AGAIN temporary DNS failure').retry,true);
  assert.equal(classifyBounce(new ApiError(429,'email_provider_error','Rate limited')).kind,'rate_limited');
  assert.equal(classifyBounce('451 4.7.1 deferred').kind,'soft');assert.equal(classifyBounce('invalid API key').kind,'configuration');
});

test('scheduled jobs remain durable and do not send before their due time',async t=>{
  const f=await setup(t);await f.subscriber();const post=await f.post();const when=new Date(Date.now()+60*60000).toISOString();const run=await schedulePost(f.services,'tenant-a',post.id,when);await f.drain();
  assert.equal(f.sent.length,0);assert.equal((await f.store.get('tenant-a','post',post.id))?.data.status,'Scheduled');assert.equal((await f.store.get('tenant-a','send_run',run.id))?.data.status,'Scheduled');
  const jobs=await f.store.list('__jobs__','job');assert.equal(jobs.items.length,1);assert.equal(jobs.items[0].data.runAt,when);
});

test('fanout sends only active eligible subscribers once and publishes after acceptance',async t=>{
  const f=await setup(t);await f.subscriber('free');await f.subscriber('premium','paid@example.net',{tier:'Premium'});await f.subscriber('pending','pending@example.net',{status:'Pending'});await f.subscriber('unsubscribed','unsub@example.net',{status:'Unsubscribed'});await f.subscriber('suppressed','blocked@example.net');await addSuppression(f.store,'tenant-a',{email:'blocked@example.net',scope:'publication',reason:'unsubscribed',permanent:true});
  const post=await f.post();const run=await schedulePost(f.services,'tenant-a',post.id,stamp());await f.drain();assert.equal(f.sent.length,2);
  for(const message of f.sent){assert.equal(message.headers?.['List-Unsubscribe-Post'],'List-Unsubscribe=One-Click');assert.match(message.headers?.['List-Unsubscribe']||'',/^<https:\/\/newsletter\.test\/api\/public\/unsubscribe\//);assert.ok(message.idempotencyKey);assert.match(message.html,/<h1[^>]*>Subject A<\/h1>/);assert.ok(['Subject A','Subject B'].includes(message.subject));assert.ok(message.tags?.find(tag=>tag.name==='publication_id'&&tag.value==='tenant-a'));}
  assert.doesNotMatch(f.sent.find(message=>message.to==='reader@example.net')!.html,/PREMIUM SECRET/);assert.match(f.sent.find(message=>message.to==='paid@example.net')!.html,/PREMIUM SECRET/);
  const delivered=await f.store.get('tenant-a','post',post.id);assert.equal(delivered?.data.status,'Published');assert.equal(delivered?.data.sentCount,2);assert.equal(delivered?.data.skippedCount,1);
  await f.services.handlers.get('post.fanout')!(handlerJob('tenant-a',{runId:run.id}),f.store);const recipient=(await f.store.list('tenant-a','send_recipient')).items[0];await f.services.handlers.get('post.recipient')!(handlerJob('tenant-a',{recipientId:recipient.id}),f.store);assert.equal(f.sent.length,2);
});

test('temporary suppressions expire while permanent and global suppressions remain effective',async t=>{
  const f=await setup(t);const sub=await f.subscriber();await f.store.insert('tenant-a','suppression',{email:sub.data.email,emailHash:hash(sub.data.email),scope:'publication',permanent:false,active:true,expiresAt:new Date(Date.now()-1000).toISOString()},'expired');assert.equal((await deliveryEligibility(f.store,'tenant-a',sub)).eligible,true);
  await addSuppression(f.store,'tenant-a',{email:sub.data.email,scope:'transactional',reason:'temporary_transactional',permanent:false,expiresAt:new Date(Date.now()+3600000).toISOString()});assert.equal((await deliveryEligibility(f.store,'tenant-a',sub,'publication')).eligible,true);assert.equal((await deliveryEligibility(f.store,'tenant-a',sub,'transactional')).eligible,false);
  await assert.rejects(()=>addSuppression(f.store,'tenant-a',{email:sub.data.email,scope:'global',reason:'manual',permanent:true}),{code:'platform_scope_required'});
  await addSuppression(f.store,'tenant-a',{email:sub.data.email,scope:'global',reason:'complaint',permanent:true},true);const second=await f.store.insert('tenant-b','subscriber',{...sub.data},'subscriber-b');assert.equal((await deliveryEligibility(f.store,'tenant-b',second)).eligible,false);
});

test('one-click unsubscribe is signed, scoped, idempotent, and GET does not mutate',async t=>{
  const f=await setup(t);const sub=await f.subscriber();const url=await createUnsubscribeLink(f.store,'tenant-a',sub.id);assert.equal(await createUnsubscribeLink(f.store,'tenant-a',sub.id),url);
  assert.equal((await f.app.request(url)).status,200);assert.equal((await f.store.get('tenant-a','subscriber',sub.id))?.data.status,'Active');
  assert.equal((await f.app.request(url.replace('tenant-a','tenant-b'),{method:'POST'})).status,400);
  assert.equal((await f.app.request(url,{method:'POST',body:'List-Unsubscribe=One-Click',headers:{'Content-Type':'application/x-www-form-urlencoded'}})).status,200);
  assert.equal((await f.app.request(url,{method:'POST'})).status,200);assert.equal((await f.store.get('tenant-a','subscriber',sub.id))?.data.status,'Unsubscribed');const rules=await f.store.list('tenant-a','suppression');assert.equal(rules.items.length,1);assert.equal(rules.items[0].data.permanent,true);
});

test('webhook verifies raw payload, rejects missing/expired signatures and deduplicates events',async t=>{
  const f=await setup(t);await f.subscriber();const post=await f.post();await schedulePost(f.services,'tenant-a',post.id,stamp());await f.drain();const body=JSON.stringify({type:'email.delivered',created_at:stamp(),data:{email_id:'provider-1'}});
  assert.throws(()=>verifyResendWebhook(body,{}),{code:'webhook_signature_invalid'});assert.throws(()=>verifyResendWebhook(body,sign(body,'expired',new Date(Date.now()-10*60000))),{code:'webhook_signature_invalid'});
  assert.equal((await f.request('/webhooks/resend',{method:'POST',body,headers:sign(body)},false)).status,202);assert.equal((await f.request('/webhooks/resend',{method:'POST',body,headers:sign(body)},false)).status,202);await f.drain();assert.equal((await f.store.list('tenant-a','email_event')).items.length,1);assert.equal((await refreshPostMetrics(f.store,'tenant-a',post.id)).delivered,1);
  assert.equal((await f.request('/webhooks/resend',{method:'POST',body:body+' ',headers:sign(body)},false)).status,401);
});

test('verified complaint suppresses globally and bot clicks never count as reader clicks',async t=>{
  const f=await setup(t);await f.subscriber();const post=await f.post();await schedulePost(f.services,'tenant-a',post.id,stamp());await f.drain();
  for(const [name,data] of [['bot',{click:{userAgent:'Proofpoint URL Scanner'}}],['human',{click:{userAgent:'Mozilla/5.0'}}],['complaint',{}]] as const){const body=JSON.stringify({type:name==='complaint'?'email.complained':'email.clicked',created_at:stamp(),data:{email_id:'provider-1',...data}});assert.equal((await f.request('/webhooks/resend',{method:'POST',body,headers:sign(body,`event-${name}`)},false)).status,202);await f.drain();}
  const metrics=await refreshPostMetrics(f.store,'tenant-a',post.id);assert.equal(metrics.uniqueClicks,1);assert.equal(metrics.botClicks,1);assert.equal(metrics.engagementVerified,false);assert.equal(metrics.complained,1);
  assert.equal((await f.store.get('tenant-a','subscriber','subscriber-a'))?.data.status,'Unsubscribed');assert.equal((await f.store.list('__delivery__','suppression')).items[0].data.reason,'complaint');assert.equal(isKnownBotClick('Mozilla/5.0'),false);
});

test('temporary provider deferrals retry with the same idempotency key for over 24 hours',async t=>{
  const calls:EmailMessage[]=[];const f=await setup(t,async message=>{calls.push(message);throw new ApiError(503,'email_provider_error','451 SMTP temporarily deferred');});await f.subscriber();const post=await f.post();await schedulePost(f.services,'tenant-a',post.id,stamp());await f.drain();
  let recipient=(await f.store.list('tenant-a','send_recipient')).items[0];assert.equal(recipient.data.status,'Deferred');assert.equal(calls.length,1);assert.ok(!recipient.data.uncertainSince);
  await f.store.update('tenant-a','send_recipient',recipient.id,{...recipient.data,firstAttemptAt:new Date(Date.now()-23*3600000).toISOString()},recipient.version);
  await assert.rejects(()=>f.services.handlers.get('post.recipient')!(handlerJob('tenant-a',{recipientId:recipient.id}),f.store),{code:'delivery_deferred'});assert.equal(calls.length,2);assert.equal(calls[0].idempotencyKey,calls[1].idempotencyKey);assert.equal(calls[0].html,calls[1].html);
  recipient=(await f.store.get('tenant-a','send_recipient',recipient.id))!;await f.store.update('tenant-a','send_recipient',recipient.id,{...recipient.data,firstAttemptAt:new Date(Date.now()-25*3600000).toISOString()},recipient.version);await f.services.handlers.get('post.recipient')!(handlerJob('tenant-a',{recipientId:recipient.id}),f.store);assert.equal((await f.store.get('tenant-a','send_recipient',recipient.id))?.data.status,'Bounced');assert.equal(calls.length,3);assert.equal((await f.store.get('tenant-a','post',post.id))?.data.status,'Draft');
});

test('unknown provider acceptance is quarantined before its idempotency window expires',async t=>{
  const f=await setup(t,async()=>{throw new TypeError('fetch failed');});await f.subscriber();const post=await f.post();await schedulePost(f.services,'tenant-a',post.id,stamp());await f.drain();let recipient=(await f.store.list('tenant-a','send_recipient')).items[0];assert.equal(recipient.data.status,'Deferred');assert.ok(recipient.data.uncertainSince);await f.store.update('tenant-a','send_recipient',recipient.id,{...recipient.data,uncertainSince:new Date(Date.now()-25*3600000).toISOString()},recipient.version);await f.services.handlers.get('post.recipient')!(handlerJob('tenant-a',{recipientId:recipient.id}),f.store);assert.equal((await f.store.get('tenant-a','send_recipient',recipient.id))?.data.status,'NeedsReview');
});

test('sender readiness requires actual verification evidence and signed event infrastructure',async t=>{
  const f=await setup(t);assert.equal((await assertSenderReady(f.store,'tenant-a')).sender,'hello@example.com');const publication=(await f.store.get('tenant-a','publication','publication-a'))!;await f.store.update('tenant-a','publication',publication.id,{...publication.data,sender:'hello@different.example.com'},publication.version);await assert.rejects(()=>assertSenderReady(f.store,'tenant-a'),{code:'sender_domain_unverified'});
  const old=config.resendWebhookSecret;config.resendWebhookSecret=undefined;try{await assert.rejects(()=>assertSenderReady(f.store,'tenant-a'),{code:'delivery_not_configured'});}finally{config.resendWebhookSecret=old;}
});

test('protected posts enforce tenant isolation, API scopes, and contributor send restrictions',async t=>{
  const f=await setup(t);const post=await f.post();assert.equal((await f.request(`/posts/${post.id}`,{},false)).status,401);assert.equal((await f.request(`/posts/${post.id}`,{headers:{'x-test-tenant':'tenant-b'}})).status,404);assert.equal((await f.request('/posts',{headers:{'x-test-key':'yes','x-test-scopes':'subscribers:read'}})).status,403);
  assert.equal((await f.request(`/posts/${post.id}/schedule`,{method:'POST',headers:{'Content-Type':'application/json','x-test-role':'contributor'},body:JSON.stringify({scheduledAt:stamp()})})).status,403);
  assert.equal((await f.request('/posts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Cannot forge',content:'Hello',status:'Published'})})).status,422);
  await schedulePost(f.services,'tenant-a',post.id,stamp());await assert.rejects(()=>updatePost(f.services,'tenant-a',post.id,{title:'Changed after scheduling'}),{code:'post_scheduled'});
});

test('public posts expose published free rendering without premium source or unpublished drafts',async t=>{
  const f=await setup(t);await f.subscriber();const draft=await f.post();assert.equal((await f.request(`/public/real-publication/posts/${draft.id}`,{},false)).status,404);await schedulePost(f.services,'tenant-a',draft.id,stamp());await f.drain();const response=await f.request(`/public/real-publication/posts/${draft.id}?tier=Premium`,{},false);assert.equal(response.status,200);const html=await response.text();assert.match(html,/Free article/);assert.doesNotMatch(html,/PREMIUM SECRET/);const listed=await(await f.request('/public/real-publication/posts',{},false)).json() as any;assert.equal(listed.items.length,1);assert.equal(listed.items[0].content,undefined);
});

test('automation messages can register provider attribution without a newsletter recipient',async t=>{
  const f=await setup(t);await f.subscriber();await registerProviderMessage(f.store,'tenant-a','automation-provider-message',{subscriberId:'subscriber-a',automationId:'automation-1',journeyId:'journey-1'});const body=JSON.stringify({type:'email.bounced',data:{email_id:'automation-provider-message',bounce:{type:'Permanent',message:'5.1.1 user unknown'}}});await f.request('/webhooks/resend',{method:'POST',body,headers:sign(body,'automation-bounce')},false);await f.drain();assert.equal((await f.store.list('__delivery__','suppression')).items[0].data.reason,'hard_bounce');assert.equal((await f.store.list('tenant-a','email_event')).items[0].data.automationId,'automation-1');
});

test('premium downgrade between attempts cannot resend a cached premium envelope',async t=>{
  let calls=0;const f=await setup(t,async()=>{calls++;throw new ApiError(503,'email_provider_error','Provider temporarily unavailable');});const sub=await f.subscriber('paid','paid@example.net',{tier:'Premium'});const post=await f.post();await schedulePost(f.services,'tenant-a',post.id,stamp());await f.drain();const recipient=(await f.store.list('tenant-a','send_recipient')).items[0];assert.match(recipient.data.message.html,/PREMIUM SECRET/);await f.store.update('tenant-a','subscriber',sub.id,{...sub.data,tier:'Free'},sub.version);await f.services.handlers.get('post.recipient')!(handlerJob('tenant-a',{recipientId:recipient.id}),f.store);assert.equal(calls,1);assert.equal((await f.store.get('tenant-a','send_recipient',recipient.id))?.data.status,'Skipped');
});

test('out-of-order deferred event cannot erase a real hard bounce',async t=>{
  const f=await setup(t);await f.subscriber();const post=await f.post();await schedulePost(f.services,'tenant-a',post.id,stamp());await f.drain();
  for(const [eventId,type,bounce] of [['bounced','email.bounced',{type:'Permanent',message:'5.1.1 user unknown'}],['older-delay','email.delivery_delayed',undefined]] as const){const body=JSON.stringify({type,created_at:stamp(),data:{email_id:'provider-1',bounce}});await f.request('/webhooks/resend',{method:'POST',body,headers:sign(body,eventId)},false);await f.drain();}
  assert.equal((await refreshPostMetrics(f.store,'tenant-a',post.id)).bounced,1);assert.equal((await f.store.list('tenant-a','send_recipient')).items[0].data.deliveryStatus,'Bounced');
});

test('personalized real-subscriber preview requires audience scope and contributor edits remain drafts',async t=>{
  const f=await setup(t);await f.subscriber();const post=await f.post();assert.equal((await f.request(`/posts/${post.id}/render?subscriberId=subscriber-a`,{headers:{'x-test-key':'yes','x-test-scopes':'posts:read'}})).status,403);assert.equal((await f.request(`/posts/${post.id}/render?subscriberId=subscriber-a`,{headers:{'x-test-role':'contributor'}})).status,403);
  await schedulePost(f.services,'tenant-a',post.id,stamp());await f.drain();assert.equal((await f.request(`/posts/${post.id}`,{method:'PATCH',headers:{'Content-Type':'application/json','x-test-role':'contributor'},body:JSON.stringify({title:'Unauthorized live edit'})})).status,403);
});

test('paid reader web access checks active entitlements on every request and revokes on downgrade',async t=>{
  const f=await setup(t);const readerId='reader:subscriber-a';await f.subscriber('subscriber-a','paid@example.net',{tier:'Free',readerUserId:readerId});const post=await f.post();await schedulePost(f.services,'tenant-a',post.id,stamp());await f.drain();const token='r'.repeat(43);await f.store.insert('tenant-a','reader_session',{userId:readerId,subscriberId:'subscriber-a',expiresAt:new Date(Date.now()+3600000).toISOString(),revoked:false},hash(token));const subscription=await f.store.insert('tenant-a','subscription',{userId:readerId,status:'active',pauseCollection:false},'subscription-paid');const path=`/public/real-publication/posts/${post.id}`;
  const paid=await f.request(path,{headers:{Cookie:`bh_reader=${token}`}},false);assert.match(await paid.text(),/PREMIUM SECRET/);assert.equal(paid.headers.get('Cache-Control'),'private, no-store');assert.equal(paid.headers.get('Vary'),'Cookie');
  await f.store.update('tenant-a','subscription',subscription.id,{...subscription.data,status:'canceled'},subscription.version);const subscriber=(await f.store.get('tenant-a','subscriber','subscriber-a'))!;await f.store.update('tenant-a','subscriber',subscriber.id,{...subscriber.data,tier:'Premium'},subscriber.version);
  assert.doesNotMatch(await(await f.request(path,{headers:{Cookie:`bh_reader=${token}`}},false)).text(),/PREMIUM SECRET/);assert.doesNotMatch(await(await f.request(path)).text(),/PREMIUM SECRET/);
});

test('default and selected templates apply current content/style snapshots with safe append/prepend',async t=>{
  const f=await setup(t);const styles={background:'#fffaf0',color:'#334455',accent:'#cc0066',font:'Georgia',fontSize:19,spacing:35};const template=await f.store.insert('tenant-a','template',{name:'Editorial',content:'<p>Template outline</p>',styles,default:true,channel:'both'},'template-main');
  const post=await createPost(f.services,'tenant-a',{title:'Template post',prependContent:'<p>Before</p>',appendContent:'<p>After</p><script>bad()</script>'});assert.equal(post.data.templateId,template.id);assert.match(post.data.content,/<p>Before<\/p><p>Template outline<\/p><p>After<\/p>/);assert.doesNotMatch(post.data.content,/script/);const rendered=renderPost({post:post.data,publication:{name:'Styled'},channel:'email',tier:'Free'});assert.match(rendered.html,/background-color:#fffaf0/);assert.match(rendered.html,/font-family:Georgia,serif;font-size:19px/);assert.match(rendered.html,/padding:35px/);assert.match(rendered.html,/border-top:4px solid #cc0066/);
  const changed=await f.store.update('tenant-a','template',template.id,{...template.data,content:'<p>Updated outline</p>'},template.version);const next=await createPost(f.services,'tenant-a',{title:'New template post',templateId:changed.id});assert.match(next.data.content,/Updated outline/);assert.match(post.data.content,/Template outline/);
  const appended=await updatePost(f.services,'tenant-a',next.id,{appendContent:'<p>Appended</p>',prependContent:'<p>Prepended</p>',version:next.version});assert.match(appended.data.content,/<p>Prepended<\/p><p>Updated outline<\/p><p>Appended<\/p>/);
});

test('a title-only PATCH preserves all omitted fields under Zod 4',async t=>{
  const f=await setup(t);const post=await createPost(f.services,'tenant-a',{title:'Old title',subtitle:'Keep subtitle',content:'<p>Keep body</p>',audience:'Premium subscribers',image:'https://example.com/image.jpg',subjectB:'Keep variant'});const updated=await updatePost(f.services,'tenant-a',post.id,{title:'New title',version:post.version});for(const field of ['subtitle','content','audience','image','subjectB'])assert.equal(updated.data[field],post.data[field]);assert.equal(updated.data.title,'New title');
});

test('Node/Vercel adapter preserves API paths and exact signed body through composed middleware',async t=>{
  const {createServer}=await import('node:http');const {getRequestListener}=await import('@hono/node-server');const {createApp}=await import('../app.js');const f=await setup(t);const app=createApp(f.services);const server=createServer(getRequestListener(request=>app.fetch(request),{overrideGlobalObjects:false}));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/api/health`)).status,200);assert.equal((await fetch(`${base}/api/posts`)).status,401);const raw=' {\n "type": "email.delivered", "data": {"email_id":"composed-message"}\n }\n';const response=await fetch(`${base}/api/webhooks/resend`,{method:'POST',headers:sign(raw,'composed-webhook'),body:raw});assert.equal(response.status,202,await response.text());const stored=await f.store.get('__delivery__','inbound_email_event',hash('composed-webhook'));assert.equal(stored?.data.event.data.email_id,'composed-message');
});
