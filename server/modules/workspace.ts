import { z } from 'zod';
import type { Api, Services, Stored } from '../contracts.js';
import { ApiError, audit, flatten, jsonBody, principal, requireRole, requireScope } from '../core/http.js';
import { configurationStatus } from '../core/config.js';
import { publicationFor } from './delivery.js';

const publicationSchema=z.object({name:z.string().trim().min(1).max(120).optional(),description:z.string().max(5000).optional(),domain:z.string().max(253).refine(value=>!value||/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i.test(value),'Use a hostname without https:// or paths.').optional(),sender:z.string().max(320).refine(value=>/^(?:[^<>\r\n]+ <)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(value),'Use a valid email sender.').optional(),accent:z.string().regex(/^#[0-9a-f]{6}$/i).optional(),version:z.number().int().positive()}).strict();

export function registerWorkspace(app:Api,services:Services){
 app.get('/workspace',async c=>{
  const p=principal(c);requireScope(c,'workspace:read');
  // Aggregated UI state is session-only; integrations use separately scoped APIs.
  if(p.apiKeyId)throw new ApiError(403,'session_required','Use the separately scoped resource APIs with an API key.');
  const publication=await publicationFor(services.store,p.tenantId);
  const kinds=p.role==='contributor'?['post','automation']:['post','subscriber','automation','product'];
  const pages=await Promise.all(kinds.map(kind=>services.store.list(p.tenantId,kind,{limit:500,order:'desc'})));
  const records=(kind:string):Stored[]=>pages[kinds.indexOf(kind)]?.items||[];
  const data={
   posts:records('post').map(r=>({...flatten(r),opens:Number(r.data.opens||0),clicks:Number(r.data.clicks||0),image:r.data.image||''})),
   subscribers:records('subscriber').map(r=>({...flatten(r),openRate:Number(r.data.openRate||0),tags:r.data.tags||[]})),
   automations:records('automation').map(r=>({...flatten(r),active:r.data.active===true,enrolled:Number(r.data.enrolled||0),steps:[]})),
   products:records('product').map(r=>({...flatten(r),sales:Number(r.data.sales||0)})),
   publication:flatten(publication),team:[],apiKeys:[],
  };
  return c.json({data,capabilities:configurationStatus(),versions:{publication:publication.version},limits:{perCollection:500,truncated:pages.some(page=>Boolean(page.nextCursor))}});
 });
 app.get('/publication',async c=>{const p=principal(c);requireScope(c,'workspace:read');return c.json(flatten(await publicationFor(services.store,p.tenantId)));});
 app.patch('/publication',async c=>{const p=requireRole(c,'admin');requireScope(c,'workspace:write');const{version,...patch}=await jsonBody(c,publicationSchema);const record=await publicationFor(services.store,p.tenantId);const changed=patch.sender!==undefined&&patch.sender!==record.data.sender||patch.domain!==undefined&&patch.domain!==record.data.domain;const saved=await services.store.update(p.tenantId,'publication',record.id,{...record.data,...patch,...(changed?{verifiedDomain:false}:{})},version);await audit(services,p,'publication.updated',{fields:Object.keys(patch)});return c.json(flatten(saved));});
 app.get('/audit',async c=>{const p=requireRole(c,'admin');requireScope(c,'workspace:read');const page=await services.store.list(p.tenantId,'audit',{limit:100,cursor:c.req.query('cursor'),order:'desc'});return c.json({items:page.items.map(flatten),nextCursor:page.nextCursor});});
 app.get('/jobs',async c=>{const p=requireRole(c,'admin');requireScope(c,'workspace:read');const page=await services.store.list('__jobs__','job',{limit:100,cursor:c.req.query('cursor'),order:'desc',filters:{tenantId:p.tenantId}});return c.json({items:page.items.map(row=>({id:row.id,type:row.data.type,status:row.data.status,attempts:row.data.attempts,runAt:row.data.runAt,lastError:row.data.lastError})),nextCursor:page.nextCursor});});
}
