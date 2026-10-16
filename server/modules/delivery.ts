import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {resolveTxt} from 'node:dns/promises';
import {Webhook} from 'svix';
import {z} from 'zod';
import type {Api, RecordData, Services, Store, Stored} from '../contracts.js';
import {ApiError, audit, hash, id, jsonBody, now, principal, requireRole, requireScope} from '../core/http.js';
import {config} from '../core/config.js';
import {resolvePublicTenant} from '../core/security.js';
import {renderPost, sanitizePostHtml} from './email-renderer.js';
import {readerIdentity} from './readers.js';
import {hasPaidEntitlement} from './commerce.js';

const GLOBAL='__delivery__';
const DAY=24*60*60*1000;
const terminal=new Set(['Accepted','Delivered','Bounced','Complained','Skipped','Failed','NeedsReview']);
const postSchema=z.object({title:z.string().trim().max(300),subtitle:z.string().max(1000).default(''),content:z.string().max(2_000_000).default('<p></p>'),audience:z.enum(['All subscribers','Free subscribers','Premium subscribers']).default('All subscribers'),image:z.string().max(2048).default(''),subjectB:z.string().max(300).optional(),status:z.literal('Draft').optional(),templateId:z.string().max(128).optional(),prependContent:z.string().max(2_000_000).optional(),appendContent:z.string().max(2_000_000).optional()}).strict();
// Zod 4 applies inner defaults even inside .partial(); PATCH fields must have no defaults.
const patchSchema=z.object({title:z.string().trim().max(300).optional(),subtitle:z.string().max(1000).optional(),content:z.string().max(2_000_000).optional(),audience:z.enum(['All subscribers','Free subscribers','Premium subscribers']).optional(),image:z.string().max(2048).optional(),subjectB:z.string().max(300).optional(),status:z.literal('Draft').optional(),templateId:z.string().max(128).optional(),prependContent:z.string().max(2_000_000).optional(),appendContent:z.string().max(2_000_000).optional(),version:z.number().int().positive().optional()}).strict();
const result=(record:Stored)=>({id:record.id,...record.data,version:record.version,createdAt:record.createdAt,updatedAt:record.updatedAt});
const emailHash=(email:string)=>hash(email.trim().toLowerCase());
const unsubscribeSecret=()=>{const value=process.env.UNSUBSCRIBE_SECRET||config.sessionSecret;if(!value||value.length<32)throw new ApiError(503,'unsubscribe_not_configured','Unsubscribe signing requires a stable secret of at least 32 characters.');return value;};
const hmac=(value:string)=>createHmac('sha256',unsubscribeSecret()).update(value).digest('base64url');
const secureEqual=(a:string,b:string)=>{const first=Buffer.from(a);const second=Buffer.from(b);return first.length===second.length&&timingSafeEqual(first,second);};
const normalizedEmail=(email:string)=>email.trim().toLowerCase();
const senderEmail=(sender:string)=>{const match=sender.match(/<([^<>]+)>\s*$/);return (match?.[1]||sender).trim().toLowerCase();};
const senderDomain=(sender:string)=>{const email=senderEmail(sender);if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))throw new ApiError(422,'sender_invalid','Configure a valid sender email address.');return email.split('@')[1];};
const safeImage=(value:string)=>!value||/^https:\/\//i.test(value)?value:'';

export type BounceClassification={kind:'hard'|'soft'|'mailbox_full'|'dns_failure'|'rate_limited'|'configuration';retry:boolean;permanent:boolean};
export function classifyBounce(value:unknown):BounceClassification {
  const data=typeof value==='string'?value:JSON.stringify(value instanceof Error?{message:value.message,status:(value as any).status,code:(value as any).code}:value||{});
  if(/mailbox.?full|quota.?exceed|over.?quota|5\.2\.2|4\.2\.2/i.test(data))return {kind:'mailbox_full',retry:true,permanent:false};
  if(/\bdns\b|ENOTFOUND|EAI_AGAIN|NXDOMAIN|name.?resolution|4\.4\.[0-9]/i.test(data))return {kind:'dns_failure',retry:true,permanent:false};
  if(/429|rate.?limit|too many requests|throttl/i.test(data))return {kind:'rate_limited',retry:true,permanent:false};
  if(/user.?unknown|unknown.?user|no.?such.?user|invalid.?recipient|recipient.?not.?found|mailbox.?does.?not.?exist|5\.1\.[1236]|"type":"permanent"|"type":"hard"/i.test(data))return {kind:'hard',retry:false,permanent:true};
  if(/401|403|invalid.?api.?key|unverified.?domain|domain.?not.?verified|validation_error|"status":400|"status":422/i.test(data))return {kind:'configuration',retry:false,permanent:false};
  return {kind:'soft',retry:true,permanent:false};
}

export async function publicationFor(store:Store,tenantId:string):Promise<Stored> {
  const record=(await store.list(tenantId,'publication',{limit:1})).items[0];
  if(!record)throw new ApiError(409,'publication_missing','Configure your publication before publishing.');
  return record;
}

async function providerDomain(domainId:string):Promise<RecordData> {
  if(!config.resendApiKey)throw new ApiError(503,'email_not_configured','Email delivery is not configured.');
  const response=await fetch(`https://api.resend.com/domains/${encodeURIComponent(domainId)}`,{headers:{Authorization:`Bearer ${config.resendApiKey}`},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new ApiError(503,'domain_provider_unavailable','Unable to verify the sender domain with the email provider.');
  return response.json() as Promise<RecordData>;
}

export async function verifySenderDomain(store:Store,tenantId:string,domainId?:string):Promise<RecordData> {
  const publication=await publicationFor(store,tenantId);
  const domain=senderDomain(publication.data.sender||config.emailFrom||'');
  const providerId=domainId||publication.data.verifiedDomain?.providerDomainId;
  const challenge=await store.transaction(async tx=>{await tx.lock(`domain-challenge:${tenantId}:${domain}`);const previous=await tx.get(tenantId,'domain_challenge',hash(domain));return previous||tx.insert(tenantId,'domain_challenge',{domain,value:`newsletter-domain-verification=${randomBytes(32).toString('hex')}`},hash(domain));});
  const challengeName=`_newsletter-verification.${domain}`;
  let dmarc:string[]=[];let senderSpf:string[]=[];
  const dns=await Promise.allSettled([resolveTxt(`_dmarc.${domain}`),resolveTxt(domain),resolveTxt(challengeName)]);
  if(dns[0].status==='fulfilled')dmarc=dns[0].value.map(parts=>parts.join('')).filter(txt=>/^v=DMARC1\s*;/i.test(txt));
  if(dns[1].status==='fulfilled')senderSpf=dns[1].value.map(parts=>parts.join('')).filter(txt=>/^v=spf1\s/i.test(txt));
  const dmarcValid=dmarc.length===1&&/\bp=(none|quarantine|reject)(?:\s*;|\s*$)/i.test(dmarc[0]);
  const ownershipVerified=dns[2].status==='fulfilled'&&dns[2].value.map(parts=>parts.join('')).includes(challenge.data.value);
  const domainRecord=providerId?await providerDomain(providerId):null;
  const exactDomain=Boolean(domainRecord&&String(domainRecord.name).toLowerCase()===domain);
  const records=Array.isArray(domainRecord?.records)?domainRecord.records:[];
  const dkim=exactDomain&&records.some((r:RecordData)=>String(r.record).toUpperCase()==='DKIM'&&String(r.type).toUpperCase()==='TXT'&&r.status==='verified');
  const spf=exactDomain&&records.some((r:RecordData)=>String(r.record).toUpperCase()==='SPF'&&String(r.type).toUpperCase()==='TXT'&&r.status==='verified');
  const verified=exactDomain&&domainRecord?.status==='verified'&&dkim&&spf&&dmarcValid&&ownershipVerified;
  const evidence={domain,provider:'resend',providerDomainId:providerId||null,status:verified?'verified':'needs_setup',verifiedAt:verified?now():null,checkedAt:now(),providerStatus:domainRecord?.status||'not_linked',alignedSender:exactDomain,ownershipVerified,ownership:{type:'TXT',name:challengeName,value:challenge.data.value,status:ownershipVerified?'verified':'missing'},dkim:dkim?'verified':'unverified',spf:spf?'verified':'unverified',dmarc:dmarcValid?'configured':'missing_or_invalid',dmarcPolicy:dmarcValid?dmarc[0].match(/\bp=(none|quarantine|reject)/i)?.[1]:null,senderSpfFound:senderSpf.length===1,notes:['Add the ownership TXT record and verify this domain in Resend, then run this check again.','DNS TXT presence alone does not prove alignment. Sending requires provider-verified DKIM/SPF and an exact sender-domain match.','SPF is checked by the provider on its envelope return-path domain. DMARC delivery alignment must also be monitored through actual receiver reports.']};
  if(verified)await store.transaction(async tx=>{const key=hash(`${tenantId}:${domain}`);await tx.lock(`domain-claim:${key}`);const claim=await tx.get(GLOBAL,'domain_claim',key);const data={tenantId,domain,providerDomainId:providerId,verifiedAt:now(),ownershipChallengeId:challenge.id};if(claim)await tx.update(GLOBAL,'domain_claim',key,data,claim.version);else await tx.insert(GLOBAL,'domain_claim',data,key);});
  await store.update(tenantId,'publication',publication.id,{...publication.data,verifiedDomain:evidence},publication.version);
  return evidence;
}

export async function assertSenderReady(store:Store,tenantId:string):Promise<{sender:string;publication:RecordData}> {
  if(!config.resendApiKey||!config.resendWebhookSecret)throw new ApiError(503,'delivery_not_configured','Configure the email provider and its signed delivery webhook before sending.');
  unsubscribeSecret();
  let publication=await publicationFor(store,tenantId);
  const sender=String(publication.data.sender||config.emailFrom||'');
  const domain=senderDomain(sender);
  let evidence=publication.data.verifiedDomain;
  if(evidence?.providerDomainId&&(!evidence.verifiedAt||Date.now()-Date.parse(evidence.verifiedAt)>DAY)){await verifySenderDomain(store,tenantId,evidence.providerDomainId);publication=await publicationFor(store,tenantId);evidence=publication.data.verifiedDomain;}
  if(!evidence||evidence.status!=='verified'||evidence.domain!==domain||evidence.provider!=='resend'||!evidence.providerDomainId||!evidence.alignedSender||!evidence.ownershipVerified||evidence.dkim!=='verified'||evidence.spf!=='verified'||evidence.dmarc!=='configured'||!Number.isFinite(Date.parse(evidence.verifiedAt))||Date.now()-Date.parse(evidence.verifiedAt)>DAY)throw new ApiError(409,'sender_domain_unverified','Verify domain ownership and the provider DKIM/SPF records, then configure DMARC before sending.');
  return {sender,publication:publication.data};
}

export async function createUnsubscribeLink(store:Store,tenantId:string,subscriberId:string):Promise<string> {
  unsubscribeSecret();
  if(!await store.get(tenantId,'subscriber',subscriberId))throw new ApiError(404,'subscriber_not_found','Subscriber not found.');
  const record=await store.transaction(async tx=>{await tx.lock(`unsubscribe:${tenantId}:${subscriberId}`);const existing=await tx.get(tenantId,'unsubscribe_token',subscriberId);if(existing)return existing;const nonce=randomBytes(32).toString('base64url');return tx.insert(tenantId,'unsubscribe_token',{subscriberId,nonce,nonceHash:hash(nonce)},subscriberId);});
  const nonce=record.data.nonce;const signature=hmac(`${tenantId}:${subscriberId}:${nonce}`);
  return `${config.appUrl.replace(/\/$/,'')}/api/public/unsubscribe/${encodeURIComponent(tenantId)}/${encodeURIComponent(subscriberId)}/${nonce}.${signature}`;
}

export async function addSuppression(store:Store,tenantId:string,input:{email:string;scope:'global'|'publication'|'transactional';reason:string;permanent:boolean;expiresAt?:string},verifiedProviderEvent=false):Promise<Stored> {
  if(input.scope==='global'&&!verifiedProviderEvent)throw new ApiError(403,'platform_scope_required','Only verified provider events can create platform-wide suppressions.');
  const tenant=input.scope==='global'?GLOBAL:tenantId;
  const address=normalizedEmail(input.email);const key=`${input.scope}:${emailHash(address)}`;
  const data={...input,email:address,emailHash:emailHash(address),active:true,expiresAt:input.permanent?null:input.expiresAt||new Date(Date.now()+DAY).toISOString(),source:verifiedProviderEvent?'verified_provider':'publication'};
  return store.transaction(async tx=>{await tx.lock(`suppression:${tenant}:${key}`);const old=await tx.get(tenant,'suppression',key);if(old?.data.permanent)return old;return old?tx.update(tenant,'suppression',key,data,old.version):tx.insert(tenant,'suppression',data,key);});
}

export async function deliveryEligibility(store:Store,tenantId:string,subscriber:Stored,scope:'publication'|'transactional'='publication'):Promise<{eligible:boolean;reason?:string}> {
  if(subscriber.data.status!=='Active')return {eligible:false,reason:`subscriber_${String(subscriber.data.status).toLowerCase()}`};
  const address=normalizedEmail(subscriber.data.email||'');const digest=emailHash(address);
  for(const tenant of [tenantId,GLOBAL]){
    const matchingFilters:Record<string,string>[]=[{emailHash:digest},{email:address}];
    for(const filters of matchingFilters){
      let cursor:string|undefined;
      do {const page=await store.list(tenant,'suppression',{limit:250,cursor,filters});for(const record of page.items){const rule=record.data;if(rule.active!==false&&(rule.scope==='global'||rule.scope===scope)&&(rule.permanent||!rule.expiresAt||Date.parse(rule.expiresAt)>Date.now()))return {eligible:false,reason:rule.reason||'suppressed'};}cursor=page.nextCursor||undefined;}while(cursor);
    }
  }
  return {eligible:true};
}

export async function registerProviderMessage(store:Store,tenantId:string,providerId:string,metadata:{subscriberId:string;recipientId?:string;postId?:string;runId?:string;automationId?:string;journeyId?:string;nodeId?:string}):Promise<void> {
  const key=hash(providerId);
  await store.transaction(async tx=>{await tx.lock(`provider:${key}`);const existing=await tx.get(GLOBAL,'provider_message',key);if(existing){if(existing.data.tenantId!==tenantId||existing.data.subscriberId!==metadata.subscriberId)throw new ApiError(409,'provider_message_conflict','Provider message already belongs to another delivery.');return;}await tx.insert(GLOBAL,'provider_message',{tenantId,providerId,...metadata},key);});
}

export async function createPost(services:Services,tenantId:string,input:unknown):Promise<Stored> {
  const parsed=postSchema.parse(input);let content=parsed.content;
  const template=parsed.templateId?await services.store.get(tenantId,'template',parsed.templateId):(await services.store.list(tenantId,'template',{limit:1,filters:{default:true}})).items[0];
  if(parsed.templateId&&!template)throw new ApiError(404,'template_not_found','Template not found.');
  if(template&&(parsed.templateId||!content.replace(/<[^>]*>/g,'').trim()))content=template.data.content||content;
  content=`${parsed.prependContent||''}${content}${parsed.appendContent||''}`;if(content.length>2_000_000)throw new ApiError(422,'post_too_large','Combined post content exceeds the 2 MB limit.');
  const {templateId,prependContent,appendContent,...data}=parsed;
  return services.store.insert(tenantId,'post',{...data,content:sanitizePostHtml(content),image:safeImage(data.image),status:'Draft',date:now(),opens:0,clicks:0,metricsSource:'provider_events',metricsVerified:false,...(template?{templateId:template.id,templateVersion:template.version,templateStyles:template.data.styles||{},templateChannel:template.data.channel||'both'}:{})});
}
export async function updatePost(services:Services,tenantId:string,postId:string,input:unknown):Promise<Stored> {
  const parsed=patchSchema.parse(input);const previous=await services.store.get(tenantId,'post',postId);if(!previous)throw new ApiError(404,'post_not_found','Post not found.');
  if(previous.data.status==='Scheduled')throw new ApiError(409,'post_scheduled','Cancel the scheduled send before editing this post.');
  const {version,templateId,status,appendContent,prependContent,...patch}=parsed;
  let template:Stored|null=null;if(templateId){template=await services.store.get(tenantId,'template',templateId);if(!template)throw new ApiError(404,'template_not_found','Template not found.');if(patch.content===undefined)patch.content=template.data.content||'';}
  if(appendContent!==undefined||prependContent!==undefined)patch.content=`${prependContent||''}${patch.content??previous.data.content}${appendContent||''}`;
  if(patch.content&&patch.content.length>2_000_000)throw new ApiError(422,'post_too_large','Combined post content exceeds the 2 MB limit.');
  if(patch.content!==undefined)patch.content=sanitizePostHtml(patch.content);
  if(patch.image!==undefined)patch.image=safeImage(patch.image);
  return services.store.update(tenantId,'post',postId,{...previous.data,...patch,...(template?{templateId:template.id,templateVersion:template.version,templateStyles:template.data.styles||{},templateChannel:template.data.channel||'both'}:{}),date:previous.data.status==='Draft'?now():previous.data.date},version??previous.version);
}

export async function schedulePost(services:Services,tenantId:string,postId:string,scheduledAt:string):Promise<Stored> {
  const scheduled=new Date(scheduledAt);if(!Number.isFinite(scheduled.getTime())||scheduled.getTime()<Date.now()-5000)throw new ApiError(422,'invalid_schedule','Choose a valid future send time.');
  const ready=await assertSenderReady(services.store,tenantId);
  return services.store.transaction(async tx=>{
    await tx.lock(`post-send:${tenantId}:${postId}`);const post=await tx.get(tenantId,'post',postId);if(!post)throw new ApiError(404,'post_not_found','Post not found.');
    if(post.data.status!=='Draft')throw new ApiError(409,'post_not_draft','Only a draft can be scheduled. Duplicate a published post to send it again.');
    if(!String(post.data.title||'').trim()||!String(post.data.content||'').replace(/<[^>]*>/g,'').trim())throw new ApiError(422,'post_empty','A subject line and message content are required.');
    const runId=id();const run=await tx.insert(tenantId,'send_run',{postId,status:'Scheduled',scheduledAt:scheduled.toISOString(),snapshot:{...post.data,content:sanitizePostHtml(post.data.content)},publication:ready.publication,sender:ready.sender,cohortSalt:randomBytes(16).toString('hex'),expected:0,processed:0,accepted:0,failed:0,skipped:0,fanoutDone:false},runId);
    await services.enqueue({type:'post.fanout',tenantId,payload:{runId},idempotencyKey:`fanout:${runId}:start`,runAt:scheduled.toISOString(),maxAttempts:128},tx);
    await tx.update(tenantId,'post',postId,{...post.data,status:'Scheduled',date:scheduled.toISOString(),sendRunId:runId,sendState:'scheduled'},post.version);
    await services.emit(tenantId,'post.scheduled',{postId,runId,scheduledAt:scheduled.toISOString()},tx);
    return run;
  });
}

async function finalizeRun(tx:Store,services:Services,tenantId:string,run:Stored):Promise<void> {
  if(!run.data.fanoutDone||run.data.processed<run.data.expected||run.data.status==='Cancelled'||run.data.status==='Completed')return;
  await tx.update(tenantId,'send_run',run.id,{...run.data,status:'Completed',completedAt:now()},run.version);
  const post=await tx.get(tenantId,'post',run.data.postId);
  if(post&&post.data.sendRunId===run.id){const published=run.data.accepted>0;await tx.update(tenantId,'post',post.id,{...post.data,status:published?'Published':'Draft',date:now(),sendState:published?'sent':'no_recipients_sent',sentCount:run.data.accepted,failedCount:run.data.failed,skippedCount:run.data.skipped},post.version);await services.emit(tenantId,published?'post.sent':'post.send_completed',{postId:post.id,runId:run.id,accepted:run.data.accepted,failed:run.data.failed,skipped:run.data.skipped},tx);}
}
async function finishRecipient(services:Services,tenantId:string,recipientId:string,status:string,patch:RecordData={}):Promise<void> {
  await services.store.transaction(async tx=>{await tx.lock(`recipient:${tenantId}:${recipientId}`);const recipient=await tx.get(tenantId,'send_recipient',recipientId);if(!recipient||terminal.has(recipient.data.status))return;await tx.update(tenantId,'send_recipient',recipientId,{...recipient.data,...patch,status,finishedAt:now()},recipient.version);await tx.lock(`run:${tenantId}:${recipient.data.runId}`);const run=await tx.get(tenantId,'send_run',recipient.data.runId);if(!run)return;const next=await tx.update(tenantId,'send_run',run.id,{...run.data,processed:run.data.processed+1,accepted:run.data.accepted+(status==='Accepted'?1:0),skipped:run.data.skipped+(status==='Skipped'?1:0),failed:run.data.failed+(!['Accepted','Skipped'].includes(status)?1:0)},run.version);await finalizeRun(tx,services,tenantId,next);});
}

async function fanout(services:Services,job:Stored):Promise<void> {
  const {runId,cursor}=job.data.payload;const tenantId=job.tenantId;
  const existing=await services.store.get(tenantId,'send_run',runId);if(!existing||['Cancelled','Completed'].includes(existing.data.status))return;
  if(Date.parse(existing.data.scheduledAt)>Date.now())throw new ApiError(503,'send_not_due','Scheduled delivery is not due yet.');
  try{await assertSenderReady(services.store,tenantId);}catch{throw new ApiError(503,'sender_not_ready','The sender configuration must be restored before delivery can continue.');}
  await services.store.transaction(async tx=>{
    await tx.lock(`run:${tenantId}:${runId}`);const run=await tx.get(tenantId,'send_run',runId);if(!run||['Cancelled','Completed'].includes(run.data.status))return;
    const batchId=hash(`${runId}:${cursor||'start'}`);if(await tx.get(tenantId,'send_batch',batchId))return;
    const page=await tx.list(tenantId,'subscriber',{limit:200,cursor,filters:{status:'Active'},order:'asc'});let created=0;
    for(const subscriber of page.items){if(run.data.snapshot.audience==='Free subscribers'&&subscriber.data.tier!=='Free'||run.data.snapshot.audience==='Premium subscribers'&&subscriber.data.tier!=='Premium')continue;const recipientId=hash(`${runId}:${subscriber.id}`);if(await tx.get(tenantId,'send_recipient',recipientId))continue;const cohort=run.data.snapshot.subjectB&&parseInt(hash(`${run.data.cohortSalt}:${subscriber.id}`).slice(0,8),16)%2===1?'B':'A';await tx.insert(tenantId,'send_recipient',{runId,postId:run.data.postId,subscriberId:subscriber.id,status:'Queued',cohort,queuedAt:now(),attempts:0},recipientId);await services.enqueue({type:'post.recipient',tenantId,payload:{recipientId},idempotencyKey:`recipient:${recipientId}`,maxAttempts:128},tx);created++;}
    await tx.insert(tenantId,'send_batch',{runId,cursor:cursor||null,count:created},batchId);
    const next=await tx.update(tenantId,'send_run',runId,{...run.data,status:'Sending',expected:run.data.expected+created,fanoutDone:!page.nextCursor},run.version);
    if(page.nextCursor)await services.enqueue({type:'post.fanout',tenantId,payload:{runId,cursor:page.nextCursor},idempotencyKey:`fanout:${runId}:${hash(page.nextCursor)}`,maxAttempts:128},tx);
    await finalizeRun(tx,services,tenantId,next);
  });
}

async function sendRecipient(services:Services,job:Stored):Promise<void> {
  const tenantId=job.tenantId;const {recipientId}=job.data.payload;
  let recipient=await services.store.get(tenantId,'send_recipient',recipientId);if(!recipient||terminal.has(recipient.data.status))return;
  const run=await services.store.get(tenantId,'send_run',recipient.data.runId);if(!run||run.data.status==='Cancelled'){await finishRecipient(services,tenantId,recipientId,'Skipped',{reason:'send_cancelled'});return;}
  const subscriber=await services.store.get(tenantId,'subscriber',recipient.data.subscriberId);if(!subscriber){await finishRecipient(services,tenantId,recipientId,'Skipped',{reason:'subscriber_deleted'});return;}
  const eligibility=await deliveryEligibility(services.store,tenantId,subscriber);if(!eligibility.eligible){await finishRecipient(services,tenantId,recipientId,'Skipped',{reason:eligibility.reason});return;}
  if(run.data.snapshot.audience==='Free subscribers'&&subscriber.data.tier!=='Free'||run.data.snapshot.audience==='Premium subscribers'&&subscriber.data.tier!=='Premium'){await finishRecipient(services,tenantId,recipientId,'Skipped',{reason:'audience_membership_changed'});return;}
  if(recipient.data.message&&(normalizedEmail(recipient.data.message.to)!==normalizedEmail(subscriber.data.email)||recipient.data.renderTier&&recipient.data.renderTier!==subscriber.data.tier)){await finishRecipient(services,tenantId,recipientId,'Skipped',{reason:'subscriber_identity_or_tier_changed'});return;}
  let ready:{sender:string;publication:RecordData};try{ready=await assertSenderReady(services.store,tenantId);}catch{throw new ApiError(503,'sender_not_ready','The sender configuration must be restored before delivery can continue.');}
  if(ready.sender!==run.data.sender){await finishRecipient(services,tenantId,recipientId,'Failed',{reason:'sender_changed_after_scheduling'});return;}
  if(recipient.data.uncertainSince&&Date.now()-Date.parse(recipient.data.uncertainSince)>=DAY-60000){await finishRecipient(services,tenantId,recipientId,'NeedsReview',{reason:'provider_acceptance_unknown',note:'Provider idempotency retention may have expired; resend requires manual reconciliation.'});return;}
  let message=recipient.data.message;
  if(!message){const unsubscribeUrl=await createUnsubscribeLink(services.store,tenantId,subscriber.id);const rendered=renderPost({post:{...run.data.snapshot,subject:recipient.data.cohort==='B'?run.data.snapshot.subjectB:run.data.snapshot.title},publication:run.data.publication,subscriber:subscriber.data,channel:'email',tier:subscriber.data.tier==='Premium'?'Premium':'Free',unsubscribeUrl});message={to:subscriber.data.email,from:run.data.sender,subject:rendered.subject,html:rendered.html,text:rendered.text,headers:{'List-Unsubscribe':`<${unsubscribeUrl}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click','Feedback-ID':`${run.data.postId}:${tenantId}:newsletter:publisher`},tags:[{name:'publication_id',value:tenantId},{name:'post_id',value:run.data.postId},{name:'subscriber_id',value:subscriber.id},{name:'cohort',value:recipient.data.cohort}],idempotencyKey:`newsletter:${recipientId}`};}
  recipient=await services.store.transaction(async tx=>{await tx.lock(`recipient:${tenantId}:${recipientId}`);const current=await tx.get(tenantId,'send_recipient',recipientId);if(!current||terminal.has(current.data.status))return current;if(current.data.leaseUntil&&Date.parse(current.data.leaseUntil)>Date.now())throw new ApiError(503,'delivery_in_flight','Delivery attempt is already in progress.');return tx.update(tenantId,'send_recipient',recipientId,{...current.data,status:'Sending',message,renderTier:subscriber.data.tier,attempts:current.data.attempts+1,firstAttemptAt:current.data.firstAttemptAt||now(),leaseUntil:new Date(Date.now()+60000).toISOString()},current.version);});
  if(!recipient||terminal.has(recipient.data.status))return;
  let response:{id:string};
  try {response=await services.sendEmail(message);}catch(error){
    const classification=classifyBounce(error);const elapsed=Date.now()-Date.parse(recipient.data.firstAttemptAt);
    if(classification.permanent){await addSuppression(services.store,tenantId,{email:subscriber.data.email,scope:'publication',reason:'hard_bounce',permanent:true});await finishRecipient(services,tenantId,recipientId,'Bounced',{bounce:classification,leaseUntil:null});return;}
    if(!classification.retry){await finishRecipient(services,tenantId,recipientId,'Failed',{reason:'provider_configuration_error',leaseUntil:null});return;}
    if(elapsed>=DAY){if(classification.kind!=='rate_limited')await addSuppression(services.store,tenantId,{email:subscriber.data.email,scope:'publication',reason:classification.kind,permanent:false,expiresAt:new Date(Date.now()+DAY).toISOString()});await finishRecipient(services,tenantId,recipientId,'Bounced',{bounce:classification,reason:'retry_window_exhausted',leaseUntil:null});return;}
    const uncertain=!(error instanceof ApiError)||(error instanceof ApiError&&error.status===502);
    const current=await services.store.get(tenantId,'send_recipient',recipientId);if(current&&!terminal.has(current.data.status))await services.store.update(tenantId,'send_recipient',recipientId,{...current.data,status:'Deferred',deferredAt:now(),lastErrorKind:classification.kind,leaseUntil:null,...(uncertain?{uncertainSince:current.data.uncertainSince||now()}: {})},current.version);
    throw new ApiError(503,'delivery_deferred','The email provider deferred this message; it will be retried.');
  }
  await registerProviderMessage(services.store,tenantId,response.id,{subscriberId:subscriber.id,recipientId,postId:run.data.postId,runId:run.id});
  await finishRecipient(services,tenantId,recipientId,'Accepted',{providerId:response.id,acceptedAt:now(),leaseUntil:null});
}

export function isKnownBotClick(userAgent:string):boolean {return /bot\b|crawler|spider|headless|proofpoint|barracuda|mimecast|link.?check|safe.?links|security.?scanner|urlscan|Microsoft Office/i.test(userAgent);}
export function verifyResendWebhook(body:string,headers:Record<string,string>,secret=config.resendWebhookSecret):RecordData {if(!secret)throw new ApiError(503,'webhook_not_configured','The provider webhook signing secret is not configured.');try{new Webhook(secret).verify(body,headers);return JSON.parse(body) as RecordData;}catch{throw new ApiError(401,'webhook_signature_invalid','The webhook signature is invalid or expired.');}}

async function processProviderEvent(services:Services,job:Stored):Promise<void> {
  const inbound=await services.store.get(GLOBAL,'inbound_email_event',job.data.payload.eventId);if(!inbound||inbound.data.processed)return;
  const event=inbound.data.event;const emailId=event.data?.email_id;const mapping=emailId?await services.store.get(GLOBAL,'provider_message',hash(emailId)):null;
  if(!mapping)throw new ApiError(503,'provider_message_pending','The provider message has not been matched to a delivery.');
  const metadata=mapping.data;const tenantId=metadata.tenantId;const subscriber=await services.store.get(tenantId,'subscriber',metadata.subscriberId);const type=event.type;
  const bounce=classifyBounce(event.data?.bounce||{});
  if(subscriber&&(type==='email.complained'||type==='email.bounced'&&bounce.permanent))await addSuppression(services.store,tenantId,{email:subscriber.data.email,scope:'global',reason:type==='email.complained'?'complaint':'hard_bounce',permanent:true},true);
  if(subscriber&&type==='email.bounced'&&!bounce.permanent)await addSuppression(services.store,tenantId,{email:subscriber.data.email,scope:'publication',reason:bounce.kind,permanent:false,expiresAt:new Date(Date.now()+DAY).toISOString()},true);
  await services.store.transaction(async tx=>{
    await tx.lock(`email-event:${inbound.id}`);const current=await tx.get(GLOBAL,'inbound_email_event',inbound.id);if(!current||current.data.processed)return;
    const agent=String(event.data?.click?.userAgent||event.data?.click?.user_agent||event.data?.open?.userAgent||event.data?.open?.user_agent||'');const bot=type==='email.clicked'&&isKnownBotClick(agent);
    if(metadata.recipientId){const recipient=await tx.get(tenantId,'send_recipient',metadata.recipientId);if(recipient){const patch:RecordData={lastProviderEvent:type,lastProviderEventAt:event.created_at||now()};if(type==='email.delivered')patch.deliveredAt=event.created_at||now();if(type==='email.bounced')Object.assign(patch,{deliveryStatus:recipient.data.complainedAt?'Complained':'Bounced',bouncedAt:event.created_at||now(),bounce});if(type==='email.complained')Object.assign(patch,{deliveryStatus:'Complained',complainedAt:now()});if(type==='email.opened')Object.assign(patch,{opened:true,openCount:(recipient.data.openCount||0)+1,openVerified:false});if(type==='email.clicked')Object.assign(patch,{clicked:recipient.data.clicked||!bot,clickCount:(recipient.data.clickCount||0)+(bot?0:1),botClickCount:(recipient.data.botClickCount||0)+(bot?1:0),clickVerified:false});if(type==='email.delivery_delayed'&&!recipient.data.bouncedAt&&!recipient.data.complainedAt)patch.deliveryStatus='Deferred by provider';await tx.update(tenantId,'send_recipient',recipient.id,{...recipient.data,...patch},recipient.version);}}
    if(subscriber&&type==='email.complained'){const fresh=await tx.get(tenantId,'subscriber',subscriber.id);if(fresh)await tx.update(tenantId,'subscriber',fresh.id,{...fresh.data,status:'Unsubscribed',unsubscribedAt:now(),unsubscribeReason:'provider_complaint'},fresh.version);}
    await tx.insert(tenantId,'email_event',{providerEventId:current.data.svixId,providerId:emailId,type,subscriberId:metadata.subscriberId,postId:metadata.postId||null,automationId:metadata.automationId||null,occurredAt:event.created_at||now(),bot,engagementVerified:false,userAgent:agent.slice(0,1000),...(type==='email.bounced'?{bounce}:{})},current.id);
    await tx.update(GLOBAL,'inbound_email_event',current.id,{...current.data,processed:true,processedAt:now()},current.version);
    await services.emit(tenantId,type,{subscriberId:metadata.subscriberId,postId:metadata.postId||null,providerId:emailId,bot,engagementVerified:false},tx);
  });
  if(metadata.postId)await refreshPostMetrics(services.store,tenantId,metadata.postId);
}

export async function refreshPostMetrics(store:Store,tenantId:string,postId:string):Promise<RecordData> {
  return store.transaction(async tx=>{await tx.lock(`post-metrics:${tenantId}:${postId}`);
  const metrics={accepted:0,delivered:0,bounced:0,complained:0,uniqueOpens:0,uniqueClicks:0,botClicks:0,opens:0,clicks:0,engagementVerified:false,source:'provider_events'};
  let cursor:string|undefined;do{const page=await tx.list(tenantId,'send_recipient',{limit:500,cursor,filters:{postId}});for(const recipient of page.items){const r=recipient.data;if(r.providerId)metrics.accepted++;if(r.deliveredAt)metrics.delivered++;if(r.bouncedAt||r.deliveryStatus==='Bounced'||r.status==='Bounced')metrics.bounced++;if(r.complainedAt)metrics.complained++;if(r.opened)metrics.uniqueOpens++;if(r.clicked)metrics.uniqueClicks++;metrics.botClicks+=r.botClickCount||0;}cursor=page.nextCursor||undefined;}while(cursor);
  metrics.opens=metrics.accepted?Math.round(metrics.uniqueOpens/metrics.accepted*1000)/10:0;metrics.clicks=metrics.accepted?Math.round(metrics.uniqueClicks/metrics.accepted*1000)/10:0;
  const post=await tx.get(tenantId,'post',postId);if(post)await tx.update(tenantId,'post',postId,{...post.data,opens:metrics.opens,clicks:metrics.clicks,metrics,metricsSource:'provider_events',metricsVerified:false},post.version);return metrics;});
}

export function renderSubscribeForm(publication:RecordData,action:string):string {
  const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
  const destination=new URL(action,config.appUrl);if(destination.origin!==new URL(config.appUrl).origin||!['http:','https:'].includes(destination.protocol))throw new ApiError(422,'subscribe_action_invalid','Subscribe forms must post to this application.');
  const turnstile=config.turnstileSiteKey?`<div class="cf-turnstile" data-sitekey="${escape(config.turnstileSiteKey)}"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`:'';
  return `<form method="post" action="${escape(destination.href)}"><h2>Subscribe to ${escape(String(publication.name||'our newsletter'))}</h2><label>Name <input name="name" autocomplete="name" maxlength="200"></label><label>Email <input name="email" type="email" autocomplete="email" required maxlength="254"></label><div hidden aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off"></div><input type="hidden" name="source" value="Website"><input type="hidden" name="startedAt" value="${Date.now()}"><label><input name="consent" type="checkbox" required> I agree to receive this newsletter. I can unsubscribe at any time.</label>${turnstile}<button type="submit">Subscribe</button></form>`;
}

export function registerDelivery(app:Api,services:Services):void {
  services.registerJob('post.fanout',job=>fanout(services,job));services.registerJob('post.recipient',job=>sendRecipient(services,job));services.registerJob('delivery.webhook',job=>processProviderEvent(services,job));
  app.get('/posts',async c=>{requireScope(c,'posts:read');const p=principal(c);const status=c.req.query('status');const page=await services.store.list(p.tenantId,'post',{limit:Math.min(100,Math.max(1,Number(c.req.query('limit'))||50)),cursor:c.req.query('cursor'),...(status?{filters:{status}}:{})});return c.json({items:page.items.map(result),nextCursor:page.nextCursor});});
  app.post('/posts',async c=>{requireRole(c,'admin','member','contributor');requireScope(c,'posts:write');const p=principal(c);const post=await createPost(services,p.tenantId,await jsonBody(c,postSchema));await audit(services,p,'post.created',{postId:post.id});return c.json(result(post),201);});
  app.get('/posts/:id',async c=>{requireScope(c,'posts:read');const p=principal(c);const post=await services.store.get(p.tenantId,'post',c.req.param('id'));if(!post)throw new ApiError(404,'post_not_found','Post not found.');return c.json(result(post));});
  app.patch('/posts/:id',async c=>{requireRole(c,'admin','member','contributor');requireScope(c,'posts:write');const p=principal(c);if(p.role==='contributor'){const current=await services.store.get(p.tenantId,'post',c.req.param('id'));if(current&&current.data.status!=='Draft')throw new ApiError(403,'draft_only','Contributors may only edit draft posts.');}return c.json(result(await updatePost(services,p.tenantId,c.req.param('id'),await jsonBody(c,patchSchema))));});
  app.delete('/posts/:id',async c=>{requireRole(c,'admin','member');requireScope(c,'posts:write');const p=principal(c);const post=await services.store.get(p.tenantId,'post',c.req.param('id'));if(!post)throw new ApiError(404,'post_not_found','Post not found.');if(post.data.status==='Scheduled')throw new ApiError(409,'post_scheduled','Cancel this scheduled send before deleting the post.');await services.store.remove(p.tenantId,'post',post.id,post.version);return c.json({deleted:true});});
  app.get('/posts/:id/render',async c=>{requireScope(c,'posts:read');const p=principal(c);const post=await services.store.get(p.tenantId,'post',c.req.param('id'));if(!post)throw new ApiError(404,'post_not_found','Post not found.');const publication=await publicationFor(services.store,p.tenantId);const subscriberId=c.req.query('subscriberId');if(subscriberId){requireRole(c,'admin','member');requireScope(c,'subscribers:read');}const subscriber=subscriberId?await services.store.get(p.tenantId,'subscriber',subscriberId):null;if(subscriberId&&!subscriber)throw new ApiError(404,'subscriber_not_found','Subscriber not found.');return c.json(renderPost({post:post.data,publication:publication.data,subscriber:subscriber?.data||{name:'Preview Reader',email:'preview@example.com'},channel:c.req.query('channel')==='web'?'web':'email',tier:c.req.query('tier')==='Premium'?'Premium':'Free'}));});
  app.post('/posts/:id/schedule',async c=>{requireRole(c,'admin','member');requireScope(c,'posts:send');const p=principal(c);const input=await jsonBody(c,z.object({scheduledAt:z.string().max(64)}).strict());const run=await schedulePost(services,p.tenantId,c.req.param('id'),input.scheduledAt);await audit(services,p,'post.scheduled',{postId:c.req.param('id'),runId:run.id});return c.json({id:run.id,...run.data},202);});
  app.post('/posts/:id/cancel',async c=>{requireRole(c,'admin','member');requireScope(c,'posts:send');const p=principal(c);await services.store.transaction(async tx=>{await tx.lock(`post-send:${p.tenantId}:${c.req.param('id')}`);const post=await tx.get(p.tenantId,'post',c.req.param('id'));if(!post)throw new ApiError(404,'post_not_found','Post not found.');const run=post.data.sendRunId?await tx.get(p.tenantId,'send_run',post.data.sendRunId):null;if(!run||run.data.status!=='Scheduled')throw new ApiError(409,'send_started','Only a scheduled send that has not started can be cancelled.');await tx.update(p.tenantId,'send_run',run.id,{...run.data,status:'Cancelled',cancelledAt:now()},run.version);await tx.update(p.tenantId,'post',post.id,{...post.data,status:'Draft',sendState:'cancelled',date:now()},post.version);});return c.json({cancelled:true});});
  app.get('/posts/:id/analytics',async c=>{requireScope(c,'posts:read');const p=principal(c);if(!await services.store.get(p.tenantId,'post',c.req.param('id')))throw new ApiError(404,'post_not_found','Post not found.');return c.json(await refreshPostMetrics(services.store,p.tenantId,c.req.param('id')));});
  app.post('/domains/verify',async c=>{requireRole(c,'admin');requireScope(c,'domains:write');const p=principal(c);const input=await jsonBody(c,z.object({providerDomainId:z.string().min(1).max(200).optional()}).strict());return c.json(await verifySenderDomain(services.store,p.tenantId,input.providerDomainId));});
  app.get('/suppressions',async c=>{requireRole(c,'admin','member');requireScope(c,'subscribers:read');const page=await services.store.list(principal(c).tenantId,'suppression',{limit:100,cursor:c.req.query('cursor')});return c.json({items:page.items.map(result),nextCursor:page.nextCursor});});
  app.post('/suppressions',async c=>{requireRole(c,'admin');requireScope(c,'subscribers:write');const p=principal(c);const input=await jsonBody(c,z.object({email:z.email(),scope:z.enum(['publication','transactional','global']).default('publication'),reason:z.string().min(1).max(200),permanent:z.boolean().default(true),expiresAt:z.iso.datetime().optional()}).strict());if(!input.permanent&&(!input.expiresAt||Date.parse(input.expiresAt)<=Date.now()))throw new ApiError(422,'expiry_required','Temporary suppressions need a future expiry.');return c.json(result(await addSuppression(services.store,p.tenantId,input)),201);});
  app.delete('/suppressions/:id',async c=>{requireRole(c,'admin');requireScope(c,'subscribers:write');const p=principal(c);const rule=await services.store.get(p.tenantId,'suppression',c.req.param('id'));if(!rule)throw new ApiError(404,'suppression_not_found','Suppression not found.');if(rule.data.permanent)throw new ApiError(409,'suppression_permanent','Permanent suppressions cannot be removed through this API.');await services.store.remove(p.tenantId,'suppression',rule.id,rule.version);return c.json({deleted:true});});
  const unsubscribe=async (c:any)=>{
    unsubscribeSecret();
    const tenantId=c.req.param('tenantId'),subscriberId=c.req.param('subscriberId'),token=c.req.param('token');const [nonce,signature,...extra]=token.split('.');
    if(!nonce||!signature||extra.length||nonce.length>200||!secureEqual(hmac(`${tenantId}:${subscriberId}:${nonce}`),signature))throw new ApiError(400,'unsubscribe_invalid','This unsubscribe link is invalid.');
    const stored=await services.store.get(tenantId,'unsubscribe_token',subscriberId);if(!stored||!secureEqual(stored.data.nonceHash,hash(nonce)))throw new ApiError(400,'unsubscribe_invalid','This unsubscribe link is invalid.');
    if(c.req.method==='GET')return c.html(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title></head><body><main><h1>Unsubscribe from this newsletter?</h1><p>You will stop receiving future newsletter emails.</p><form method="post"><button type="submit">Unsubscribe</button></form></main></body></html>`);
    const subscriber=await services.store.get(tenantId,'subscriber',subscriberId);if(subscriber){await services.store.transaction(async tx=>{await tx.lock(`subscriber:${tenantId}:${subscriberId}`);const fresh=await tx.get(tenantId,'subscriber',subscriberId);if(fresh&&fresh.data.status!=='Unsubscribed'){await tx.update(tenantId,'subscriber',subscriberId,{...fresh.data,status:'Unsubscribed',unsubscribedAt:now(),unsubscribeReason:'one_click'},fresh.version);await services.emit(tenantId,'subscriber.unsubscribed',{subscriberId},tx);}});await addSuppression(services.store,tenantId,{email:subscriber.data.email,scope:'publication',reason:'unsubscribed',permanent:true});}
    c.header('Cache-Control','no-store');return c.json({unsubscribed:true});
  };
  app.get('/public/unsubscribe/:tenantId/:subscriberId/:token',unsubscribe);app.post('/public/unsubscribe/:tenantId/:subscriberId/:token',unsubscribe);
  app.post('/webhooks/resend',async c=>{const body=await c.req.text();if(body.length>1_000_000)throw new ApiError(413,'payload_too_large','Webhook payload is too large.');const svixId=c.req.header('svix-id')||'';const event=verifyResendWebhook(body,{'svix-id':svixId,'svix-timestamp':c.req.header('svix-timestamp')||'','svix-signature':c.req.header('svix-signature')||''});if(typeof event.type!=='string'||!event.data?.email_id)return c.json({received:true,ignored:true},202);const eventId=hash(svixId);await services.store.transaction(async tx=>{await tx.lock(`webhook:${eventId}`);if(await tx.get(GLOBAL,'inbound_email_event',eventId))return;await tx.insert(GLOBAL,'inbound_email_event',{svixId,event,processed:false,receivedAt:now()},eventId);await services.enqueue({type:'delivery.webhook',tenantId:GLOBAL,payload:{eventId},idempotencyKey:`resend:${eventId}`,maxAttempts:16},tx);});return c.json({received:true},202);});
  app.get('/public/:slug/posts',async c=>{const tenantId=await resolvePublicTenant(services.store,c.req.param('slug'));const page=await services.store.list(tenantId,'post',{limit:30,cursor:c.req.query('cursor'),filters:{status:'Published'}});return c.json({items:page.items.map(post=>({id:post.id,title:post.data.title,subtitle:post.data.subtitle,image:post.data.image,date:post.data.date})),nextCursor:page.nextCursor});});
  app.get('/public/:slug/posts/:id',async c=>{const tenantId=await resolvePublicTenant(services.store,c.req.param('slug'));const post=await services.store.get(tenantId,'post',c.req.param('id'));if(!post||post.data.status!=='Published')throw new ApiError(404,'post_not_found','Post not found.');const publication=await publicationFor(services.store,tenantId);let tier:'Free'|'Premium'='Free';let subscriber:RecordData|undefined;try{const reader=await readerIdentity(c,services,tenantId);if(await hasPaidEntitlement(services.store,tenantId,reader.userId))tier='Premium';subscriber=(await services.store.get(tenantId,'subscriber',reader.subscriberId))?.data;}catch(error){if(!(error instanceof ApiError)||error.status!==401)throw error;}const rendered=renderPost({post:post.data,publication:publication.data,subscriber,channel:'web',tier});c.header('Cache-Control','private, no-store');c.header('Vary','Cookie');c.header('Content-Security-Policy',"default-src 'none'; img-src https:; style-src 'unsafe-inline'; media-src https:; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");return c.html(rendered.html);});
}
