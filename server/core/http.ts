import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Ctx, Principal, Role, Services } from '../contracts.js';
export class ApiError extends Error { constructor(public status:number, public code:string, message:string, public details?:unknown){super(message);this.name='ApiError';} }
export async function jsonBody<T extends z.ZodType>(c:Ctx,schema:T):Promise<z.infer<T>> {
 let body:unknown;try{body=await c.req.json();}catch{throw new ApiError(400,'invalid_json','A valid JSON request body is required.');}
 const result=schema.safeParse(body);if(!result.success)throw new ApiError(422,'validation_error','Check the request fields.',result.error.issues.map(i=>({path:i.path.join('.'),message:i.message})));return result.data;
}
export function principal(c:Ctx):Principal {const p=c.get('principal');if(!p)throw new ApiError(401,'authentication_required','Sign in to continue.');return p;}
export function requireRole(c:Ctx,...roles:Role[]):Principal {const p=principal(c);if(!roles.includes(p.role))throw new ApiError(403,'forbidden','Your role does not allow this action.');return p;}
export function requireScope(c:Ctx,scope:string):Principal {const p=principal(c);if(p.apiKeyId&&!p.scopes?.includes(scope)&&!p.scopes?.includes('*'))throw new ApiError(403,'insufficient_scope',`The API key requires the ${scope} scope.`);return p;}
export const id=()=>randomUUID();export const now=()=>new Date().toISOString();export const hash=(value:string)=>createHash('sha256').update(value).digest('hex');export const randomToken=(bytes=32)=>randomBytes(bytes).toString('base64url');
export async function audit(services:Services,p:Principal,action:string,details:Record<string,unknown>={}) {await services.store.insert(p.tenantId,'audit',{actorId:p.userId,apiKeyId:p.apiKeyId||null,action,details,at:now()});}
export const flatten=(r:{id:string;data:Record<string,any>;version:number;createdAt:string;updatedAt:string})=>({...r.data,id:r.id,version:r.version,createdAt:r.createdAt,updatedAt:r.updatedAt});
export const pagination=(c:Ctx)=>({limit:Math.min(500,Math.max(1,Number(c.req.query('limit'))||50)),cursor:c.req.query('cursor')});
