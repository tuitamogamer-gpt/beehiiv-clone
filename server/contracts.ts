import type { Context, Hono } from 'hono';
export type Role = 'admin' | 'member' | 'contributor';
export type Principal = { userId:string; tenantId:string; role:Role; sessionId?:string; apiKeyId?:string; scopes?:string[] };
export type Variables = { principal:Principal; requestId:string };
export type Api = Hono<{Variables:Variables}>;
export type Ctx = Context<{Variables:Variables}>;
export type RecordData = Record<string, any>;
export type Stored<T extends RecordData = RecordData> = {id:string;tenantId:string;kind:string;data:T;version:number;createdAt:string;updatedAt:string};
export type ListOptions = {limit?:number;cursor?:string;filters?:Record<string,string|number|boolean|null>;order?:'asc'|'desc'};
export type Page<T extends RecordData = RecordData> = {items:Stored<T>[];nextCursor:string|null};
export interface Store {
 get<T extends RecordData = RecordData>(tenantId:string,kind:string,id:string):Promise<Stored<T>|null>;
 list<T extends RecordData = RecordData>(tenantId:string,kind:string,options?:ListOptions):Promise<Page<T>>;
 insert<T extends RecordData = RecordData>(tenantId:string,kind:string,data:T,id?:string):Promise<Stored<T>>;
 update<T extends RecordData = RecordData>(tenantId:string,kind:string,id:string,data:T,expectedVersion?:number):Promise<Stored<T>>;
 remove(tenantId:string,kind:string,id:string,expectedVersion?:number):Promise<boolean>;
 transaction<T>(fn:(store:Store)=>Promise<T>):Promise<T>;
 lock(key:string):Promise<void>;
 close():Promise<void>;
}
export type Job = {type:string;tenantId:string;payload:RecordData;idempotencyKey?:string;runAt?:string;maxAttempts?:number};
export type JobHandler = (job:Stored,store:Store)=>Promise<void>;
export type EmailMessage = {to:string;from:string;subject:string;html:string;text?:string;replyTo?:string;headers?:Record<string,string>;tags?:{name:string;value:string}[];idempotencyKey?:string};
export type Services = {
 store:Store;
 enqueue:(job:Job,store?:Store)=>Promise<Stored>;
 emit:(tenantId:string,event:string,data:RecordData,store?:Store)=>Promise<void>;
 registerJob:(type:string,handler:JobHandler)=>void;
 sendEmail:(message:EmailMessage)=>Promise<{id:string}>;
};
