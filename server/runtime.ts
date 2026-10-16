import { createApp } from './app.js';
import { getStore } from './core/store.js';
import { createServices } from './core/services.js';
import { ApiError } from './core/http.js';
import { configurationStatus } from './core/config.js';
let runtime:Promise<ReturnType<typeof createApp>>|undefined;
export async function handleRequest(request:Request):Promise<Response>{
 const path=new URL(request.url).pathname;
 const headers={'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
 if(path==='/api/status')return Response.json({capabilities:configurationStatus(),service:'newsletter-backend',version:1},{headers});
 if(path==='/api/health')return Response.json({ok:true,service:'newsletter-backend'},{headers});
 try{if(!runtime){runtime=getStore().then(store=>createApp(createServices(store)));runtime.catch(()=>{runtime=undefined;});}return await(await runtime).fetch(request);}catch(error){const known=error instanceof ApiError;return Response.json({error:{code:known?error.code:'backend_unavailable',message:known?error.message:'The database is unavailable. Check its connection and migrations.'}},{status:known?error.status:503,headers});}
}
