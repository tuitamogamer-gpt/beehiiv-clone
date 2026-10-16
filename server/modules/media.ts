import { get, put, del } from '@vercel/blob';
import sharp from 'sharp';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Api, Services, Store, Stored } from '../contracts.js';
import { ApiError, audit, hash, id, jsonBody, randomToken, requireScope, requireRole, principal } from '../core/http.js';
import { config } from '../core/config.js';
import { rateLimit, secureEqual } from '../core/security.js';

const MAX_BYTES=4*1024*1024;
const localRoot=resolve('.data/media');
const view=(record:Stored)=>({id:record.id,name:record.data.name,mimeType:record.data.mimeType,size:record.data.size,width:record.data.width,height:record.data.height,alt:record.data.alt||'',caption:record.data.caption||'',createdAt:record.createdAt,version:record.version,downloadUrl:`/api/media/${record.id}/content`});
function localPath(pathname:string){const file=resolve(localRoot,pathname);if(!file.startsWith(localRoot+'/'))throw new ApiError(400,'invalid_media_path','Invalid storage path.');return file;}

/** Assets are tenant-owned and private; callers must enforce purchaser/feed access. */
export async function readMedia(store:Store,tenantId:string,mediaId:string):Promise<{body:ReadableStream<Uint8Array>|Uint8Array;contentType:string;filename:string}>{
 const record=await store.get(tenantId,'media',mediaId);if(!record)throw new ApiError(404,'media_not_found','Media not found.');
 if(record.data.storage==='local'&&!config.production){try{return{body:new Uint8Array(await readFile(localPath(record.data.pathname))),contentType:record.data.mimeType,filename:record.data.name};}catch{throw new ApiError(404,'media_not_found','Media file not found.');}}
 if(record.data.storage!=='blob'||!config.blobToken)throw new ApiError(503,'media_not_configured','Configure private Vercel Blob storage.');
 const result=await get(record.data.pathname,{access:'private',token:config.blobToken});if(!result||result.statusCode!==200)throw new ApiError(404,'media_not_found','Media file not found.');
 return{body:result.stream,contentType:record.data.mimeType,filename:record.data.name};
}

export async function saveMedia(services:Services,tenantId:string,userId:string,bytes:Uint8Array,name:string,mimeType:string){
 if(bytes.length===0||bytes.length>MAX_BYTES)throw new ApiError(413,'media_size','Upload a file between 1 byte and 4 MB.');
 let body=Buffer.from(bytes);let width:number|undefined,height:number|undefined;
 const cleanName=name.replace(/[\r\n\x00-\x1f/\\]/g,'_').slice(0,150)||'attachment';
 if(mimeType.startsWith('image/')){
  if(!['image/jpeg','image/png','image/webp','image/gif','image/avif'].includes(mimeType))throw new ApiError(422,'unsupported_image','Use PNG, JPEG, WebP, GIF or AVIF.');
  try{const optimized=await sharp(body,{limitInputPixels:40_000_000}).rotate().resize({width:1920,height:1920,fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer({resolveWithObject:true});body=Buffer.from(optimized.data);width=optimized.info.width;height=optimized.info.height;mimeType='image/webp';}catch{throw new ApiError(422,'invalid_image','The image cannot be decoded safely.');}
 }else if(!['application/pdf','text/plain','text/csv','application/zip','audio/mpeg','audio/mp4','audio/ogg','audio/wav'].includes(mimeType))throw new ApiError(422,'unsupported_media','This file type is not supported.');
 if(mimeType==='application/pdf'&&body.subarray(0,5).toString()!=='%PDF-')throw new ApiError(422,'invalid_pdf','This file is not a PDF.');
 const mediaId=id(),pathname=`${tenantId}/${mediaId}`;let storage='local';
 if(config.blobToken){await put(pathname,body,{access:'private',token:config.blobToken,contentType:mimeType,addRandomSuffix:false});storage='blob';}
 else{if(config.production)throw new ApiError(503,'media_not_configured','Connect private Vercel Blob storage before uploading.');await mkdir(resolve(localRoot,tenantId),{recursive:true});await writeFile(localPath(pathname),body,{flag:'wx',mode:0o600});}
 try{return await services.store.insert(tenantId,'media',{name:cleanName,mimeType,size:body.length,width:width||null,height:height||null,storage,pathname,access:'private',createdBy:userId},mediaId);}catch(error){if(storage==='blob')await del(pathname,{token:config.blobToken}).catch(()=>{});else await unlink(localPath(pathname)).catch(()=>{});throw error;}
}

export function registerMedia(app:Api,services:Services){
 app.post('/media/:id/publish',async c=>{const p=requireRole(c,'admin','member','contributor');requireScope(c,'media:write');const record=await services.store.get(p.tenantId,'media',c.req.param('id'));if(!record)throw new ApiError(404,'media_not_found','Media not found.');if(!/^image\/|^audio\//.test(record.data.mimeType))throw new ApiError(422,'media_not_publishable','Only images and audio can be published for public embeds.');const token=randomToken();await services.store.update(p.tenantId,'media',record.id,{...record.data,publicTokenHash:hash(token)},record.version);await audit(services,p,'media.published',{mediaId:record.id});return c.json({url:`${config.appUrl}/api/public/media/${p.tenantId}/${record.id}/${token}`,visibility:'anyone_with_link',note:'Publishing again rotates this link. Use the returned URL in email or web embeds.'});});
 app.delete('/media/:id/public',async c=>{const p=requireRole(c,'admin','member');requireScope(c,'media:write');const record=await services.store.get(p.tenantId,'media',c.req.param('id'));if(!record)throw new ApiError(404,'media_not_found','Media not found.');await services.store.update(p.tenantId,'media',record.id,{...record.data,publicTokenHash:null},record.version);return c.body(null,204);});
 app.get('/public/media/:tenantId/:mediaId/:token',async c=>{const tenant=c.req.param('tenantId'),record=await services.store.get(tenant,'media',c.req.param('mediaId'));if(!record?.data.publicTokenHash||!secureEqual(record.data.publicTokenHash,hash(c.req.param('token')))||!/^image\/|^audio\//.test(record.data.mimeType))throw new ApiError(404,'media_not_found','Published media not found.');const file=await readMedia(services.store,tenant,record.id);return new Response(file.body as BodyInit,{headers:{'Content-Type':file.contentType,'Content-Disposition':'inline','X-Content-Type-Options':'nosniff','Cache-Control':'private, max-age=60','Content-Security-Policy':"default-src 'none'; sandbox"}});});
 app.get('/media',async c=>{const p=principal(c);requireScope(c,'media:read');const page=await services.store.list(p.tenantId,'media',{limit:50,cursor:c.req.query('cursor')});return c.json({items:page.items.map(view),nextCursor:page.nextCursor});});
 app.post('/media',async c=>{const p=requireRole(c,'admin','member','contributor');requireScope(c,'media:write');await rateLimit(services,`media:${p.tenantId}`,30,60);let form:FormData;try{form=await c.req.formData();}catch{throw new ApiError(400,'invalid_upload','Send a multipart file field.');}const file=form.get('file');if(!(file instanceof File))throw new ApiError(422,'file_required','A file is required.');if(file.size>MAX_BYTES)throw new ApiError(413,'media_size','The upload limit is 4 MB.');const record=await saveMedia(services,p.tenantId,p.userId,new Uint8Array(await file.arrayBuffer()),file.name,file.type);await audit(services,p,'media.upload',{mediaId:record.id,size:record.data.size});return c.json(view(record),201);});
 app.patch('/media/:id',async c=>{const p=requireRole(c,'admin','member','contributor');requireScope(c,'media:write');const body=await jsonBody(c,z.object({alt:z.string().max(1000).optional(),caption:z.string().max(5000).optional(),name:z.string().min(1).max(150).optional(),version:z.number().int().positive()}).strict());const record=await services.store.get(p.tenantId,'media',c.req.param('id'));if(!record)throw new ApiError(404,'media_not_found','Media not found.');const{version,...patch}=body;return c.json(view(await services.store.update(p.tenantId,'media',record.id,{...record.data,...patch},version)));});
 app.get('/media/:id/content',async c=>{const p=principal(c);requireScope(c,'media:read');const file=await readMedia(services.store,p.tenantId,c.req.param('id'));c.header('Content-Type',file.contentType);c.header('Content-Disposition',`${file.contentType.startsWith('image/')||file.contentType.startsWith('audio/')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`);c.header('X-Content-Type-Options','nosniff');c.header('Content-Security-Policy',"default-src 'none'; sandbox");return new Response(file.body as BodyInit,{headers:c.res.headers});});
 app.delete('/media/:id',async c=>{const p=requireRole(c,'admin','member');requireScope(c,'media:write');const record=await services.store.get(p.tenantId,'media',c.req.param('id'));if(!record)throw new ApiError(404,'media_not_found','Media not found.');if(record.data.storage==='blob'){if(!config.blobToken)throw new ApiError(503,'media_not_configured','Media storage is not configured.');await del(record.data.pathname,{token:config.blobToken});}else if(!config.production)await unlink(localPath(record.data.pathname)).catch(()=>{});else throw new ApiError(503,'media_unavailable','Media storage is unavailable.');await services.store.remove(p.tenantId,'media',record.id,record.version);return c.body(null,204);});
}
