import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import type { Store, Stored, RecordData, ListOptions, Page } from '../contracts.js';
import { ApiError, id, now } from './http.js';
import { config } from './config.js';
type QueryResult={rows:Record<string,any>[];count:number};
class Mutex { private tail:Promise<unknown>=Promise.resolve(); async run<T>(fn:()=>Promise<T>):Promise<T>{const previous=this.tail;let release!:()=>void;this.tail=new Promise<void>(r=>release=r);await previous;try{return await fn();}finally{release();}} }
interface Driver {dialect:'sqlite'|'postgres';query(sql:string,params?:any[]):Promise<QueryResult>;transaction<T>(fn:(driver:Driver)=>Promise<T>):Promise<T>;close():Promise<void>;inTransaction:boolean}
class SQLiteDriver implements Driver {
 dialect='sqlite' as const;constructor(private db:DatabaseSync,private mutex=new Mutex(),public inTransaction=false){}
 async query(sql:string,params:any[]=[]){const run=async()=>{const bound:any[]=[];const prepared=sql.replace(/\$(\d+)/g,(_,n)=>{const value=params[Number(n)-1];bound.push(typeof value==='boolean'?Number(value):value);return '?';});const stmt=this.db.prepare(prepared);const result=stmt.all(...bound);return{rows:result,count:result.length};};return this.inTransaction?run():this.mutex.run(run);}
 async transaction<T>(fn:(driver:Driver)=>Promise<T>):Promise<T>{if(this.inTransaction)return fn(this);return this.mutex.run(async()=>{this.db.exec('BEGIN IMMEDIATE');try{const result=await fn(new SQLiteDriver(this.db,this.mutex,true));this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}});}
 async close(){this.db.close();}
}
class PostgresDriver implements Driver {
 dialect='postgres' as const;constructor(private pool:Pool,private client?:PoolClient,public inTransaction=false){}
 async query(sql:string,params:any[]=[]){const result=await(this.client||this.pool).query(sql,params);return{rows:result.rows,count:result.rowCount||0};}
 async transaction<T>(fn:(driver:Driver)=>Promise<T>):Promise<T>{if(this.inTransaction)return fn(this);const client=await this.pool.connect();try{await client.query('BEGIN');const result=await fn(new PostgresDriver(this.pool,client,true));await client.query('COMMIT');return result;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
 async close(){if(!this.client)await this.pool.end();}
}
const rowToRecord=<T extends RecordData>(r:Record<string,any>):Stored<T>=>({id:r.id,tenantId:r.tenant_id,kind:r.kind,data:typeof r.data==='string'?JSON.parse(r.data):r.data,version:Number(r.version),createdAt:String(r.created_at),updatedAt:String(r.updated_at)});
class SQLStore implements Store {
 constructor(private driver:Driver){}
 async get<T extends RecordData=RecordData>(tenantId:string,kind:string,recordId:string):Promise<Stored<T>|null>{const {rows}=await this.driver.query('SELECT * FROM records WHERE tenant_id=$1 AND kind=$2 AND id=$3',[tenantId,kind,recordId]);return rows[0]?rowToRecord<T>(rows[0]):null;}
 async list<T extends RecordData=RecordData>(tenantId:string,kind:string,options:ListOptions={}):Promise<Page<T>>{
  const values:any[]=[tenantId,kind];let where='tenant_id=$1 AND kind=$2';const limit=Math.min(500,Math.max(1,Math.floor(options.limit||50)));const direction=options.order==='desc'?'DESC':'ASC';
  for(const [key,value] of Object.entries(options.filters||{})){if(!/^[A-Za-z][\w.]{0,80}$/.test(key)||values.length>36)throw new ApiError(400,'invalid_filter','Invalid filter field.');
   values.push(this.driver.dialect==='postgres'?key.split('.'):'$.'+key);const expression=this.driver.dialect==='postgres'?`data #>> $${values.length}::text[]`:`json_extract(data, $${values.length})`;
   if(value===null)where+=` AND ${expression} IS NULL`;else{values.push(String(typeof value==='boolean'&&this.driver.dialect==='sqlite'?Number(value):value));where+=` AND CAST(${expression} AS TEXT)=$${values.length}`;}
  }
  if(options.cursor){let cursor:any;try{cursor=JSON.parse(Buffer.from(options.cursor,'base64url').toString());}catch{throw new ApiError(400,'invalid_cursor','The pagination cursor is invalid.');}if(!Array.isArray(cursor)||cursor.length!==2||cursor.some(x=>typeof x!=='string'||x.length>100))throw new ApiError(400,'invalid_cursor','The pagination cursor is invalid.');const comparator=direction==='ASC'?'>':'<';values.push(cursor[0],cursor[1]);where+=` AND (created_at ${comparator} $${values.length-1} OR (created_at=$${values.length-1} AND id ${comparator} $${values.length}))`;}
  values.push(limit+1);const {rows}=await this.driver.query(`SELECT * FROM records WHERE ${where} ORDER BY created_at ${direction}, id ${direction} LIMIT $${values.length}`,values);
  const items=rows.slice(0,limit).map(r=>rowToRecord<T>(r));const last=items.at(-1);return{items,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify([last.createdAt,last.id])).toString('base64url'):null};
 }
 async insert<T extends RecordData=RecordData>(tenantId:string,kind:string,data:T,recordId=id()):Promise<Stored<T>>{const time=now();try{const result=await this.driver.query('INSERT INTO records (tenant_id,kind,id,data,version,created_at,updated_at) VALUES ($1,$2,$3,$4,1,$5,$6) RETURNING *',[tenantId,kind,recordId,JSON.stringify(data),time,time]);return rowToRecord<T>(result.rows[0]);}catch(error:any){if(error.code==='23505'||error.code==='ERR_SQLITE_ERROR'&&/UNIQUE constraint/.test(error.message))throw new ApiError(409,'conflict','This record already exists.');throw error;}}
 async update<T extends RecordData=RecordData>(tenantId:string,kind:string,recordId:string,data:T,expectedVersion?:number):Promise<Stored<T>>{const version=expectedVersion??(await this.get(tenantId,kind,recordId))?.version;if(version===undefined)throw new ApiError(404,'not_found','Record not found.');const {rows}=await this.driver.query('UPDATE records SET data=$1, version=version+1, updated_at=$2 WHERE tenant_id=$3 AND kind=$4 AND id=$5 AND version=$6 RETURNING *',[JSON.stringify(data),now(),tenantId,kind,recordId,version]);if(!rows[0])throw new ApiError(409,'version_conflict','This record changed. Refresh it before saving again.');return rowToRecord<T>(rows[0]);}
 async remove(tenantId:string,kind:string,recordId:string,expectedVersion?:number):Promise<boolean>{const values:any[]=[tenantId,kind,recordId];let sql='DELETE FROM records WHERE tenant_id=$1 AND kind=$2 AND id=$3';if(expectedVersion!==undefined){values.push(expectedVersion);sql+=' AND version=$4';}const result=await this.driver.query(sql+' RETURNING id',values);if(!result.count&&expectedVersion!==undefined)throw new ApiError(409,'version_conflict','This record changed. Refresh it before deleting.');return result.count>0;}
 async transaction<T>(fn:(store:Store)=>Promise<T>):Promise<T>{return this.driver.transaction(driver=>fn(new SQLStore(driver)));}
 async lock(key:string){if(!this.driver.inTransaction)throw new Error('lock requires a transaction');if(this.driver.dialect==='postgres')await this.driver.query('SELECT pg_advisory_xact_lock(hashtext($1))',[key]);}
 async close(){await this.driver.close();}
}
async function migrate(driver:Driver){
 await driver.query(`CREATE TABLE IF NOT EXISTS records (tenant_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, data ${driver.dialect==='postgres'?'JSONB':'TEXT'} NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(tenant_id,kind,id))`);
 await driver.query('CREATE INDEX IF NOT EXISTS records_pagination ON records(tenant_id,kind,created_at,id)');
 if(driver.dialect==='postgres'){await driver.query("CREATE INDEX IF NOT EXISTS records_email ON records(tenant_id,kind,(data->>'email'))");await driver.query("CREATE INDEX IF NOT EXISTS records_status ON records(tenant_id,kind,(data->>'status'))");await driver.query("CREATE INDEX IF NOT EXISTS records_data_gin ON records USING GIN (data)");}
 await driver.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
 await driver.query('INSERT INTO schema_migrations(version,applied_at) VALUES (1,$1) ON CONFLICT(version) DO NOTHING',[now()]);
}
export async function createSqliteStore(path=':memory:'):Promise<Store>{if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');const driver=new SQLiteDriver(db);await migrate(driver);return new SQLStore(driver);}
export async function createPostgresStore(connectionString:string):Promise<Store>{const pool=new Pool({connectionString,max:5,idleTimeoutMillis:10000,connectionTimeoutMillis:10000});const driver=new PostgresDriver(pool);try{await driver.transaction(async tx=>{await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['newsletter-schema-v1']);await migrate(tx);});}catch(error){await pool.end();throw error;}return new SQLStore(driver);}
let singleton:Promise<Store>|undefined;
export function getStore():Promise<Store>{if(!singleton){if(config.databaseUrl)singleton=createPostgresStore(config.databaseUrl);else if(!config.production)singleton=createSqliteStore(config.sqlitePath);else throw new ApiError(503,'database_not_configured','Connect PostgreSQL and set DATABASE_URL to activate the backend.');singleton.catch(()=>{singleton=undefined;});}return singleton;}
export async function allRecords<T extends RecordData=RecordData>(store:Store,tenantId:string,kind:string,filters?:ListOptions['filters'],max=20000){const items:Stored<T>[]=[];let cursor:string|undefined;do{const page=await store.list<T>(tenantId,kind,{limit:500,cursor,filters});items.push(...page.items);cursor=page.nextCursor||undefined;if(items.length>max)throw new ApiError(422,'collection_too_large','Use the paginated API for this collection.');}while(cursor);return items;}
