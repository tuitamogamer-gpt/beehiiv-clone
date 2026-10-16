import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import ipaddr from 'ipaddr.js';
import { ApiError } from './http.js';
export function isPrivateAddress(address:string):boolean{
 try{const parsed=ipaddr.process(address.replace(/^\[|\]$/g,''));return parsed.range()!=='unicast';}catch{return true;}
}
export async function validatePublicUrl(input:string){
 let url:URL;try{url=new URL(input);}catch{throw new ApiError(422,'invalid_url','A valid HTTPS URL is required.');}
 if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||url.hostname==='localhost'||url.hostname.endsWith('.local')||url.hostname.endsWith('.internal'))throw new ApiError(422,'unsafe_url','Only public HTTPS destinations on port 443 are supported.');
 const host=url.hostname.replace(/^\[|\]$/g,'');let addresses:{address:string;family:number}[];let timer:ReturnType<typeof setTimeout>|undefined;
 try{addresses=isIP(host)?[{address:host,family:isIP(host)}]:await Promise.race([lookup(host,{all:true}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('DNS deadline exceeded')),3000);})]);}catch{throw new ApiError(422,'unreachable_url','The destination hostname could not be resolved.');}finally{if(timer)clearTimeout(timer);}
 if(!addresses.length||addresses.some(a=>isPrivateAddress(a.address)))throw new ApiError(422,'unsafe_url','Private or reserved network addresses are not allowed.');return{url,addresses};
}
export async function safeFetch(input:string,options:RequestInit={}):Promise<Response>{
 if(options.signal?.aborted)throw new ApiError(499,'request_cancelled','Remote request cancelled.');
 const {url,addresses}=await validatePublicUrl(input);const headers=new Headers(options.headers);for(const name of ['host','connection','cookie','proxy-authorization'])headers.delete(name);
 const body=typeof options.body==='string'?options.body:options.body instanceof Uint8Array?options.body:undefined;if(options.body!==undefined&&body===undefined)throw new ApiError(422,'invalid_body','Only text or binary webhook bodies are supported.');
 return new Promise((resolve,reject)=>{
  const selected=addresses[0];let deadline:ReturnType<typeof setTimeout>;
  const request=httpsRequest(url,{method:options.method||'GET',headers:Object.fromEntries(headers.entries()),lookup:((_hostname:any,_options:any,callback:any)=>{if(_options?.all)callback(null,[selected]);else callback(null,selected.address,selected.family);}) as any,timeout:15000},response=>{
   const chunks:Buffer[]=[];let size=0;
   response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>2*1024*1024){request.destroy(new ApiError(502,'response_too_large','Remote response exceeded 2 MB.'));return;}chunks.push(chunk);});
   response.on('end',()=>{cleanup();const outHeaders=new Headers();for(const[k,v]of Object.entries(response.headers))if(v!==undefined)outHeaders.set(k,Array.isArray(v)?v.join(', '):v);const status=response.statusCode||502;resolve(new Response([204,205,304].includes(status)?null:new Uint8Array(Buffer.concat(chunks)),{status,headers:outHeaders}));});response.on('error',fail);
  });
  const abort=()=>request.destroy(new Error('Remote request cancelled.'));
  function cleanup(){clearTimeout(deadline);options.signal?.removeEventListener('abort',abort);}
  function fail(error:Error){cleanup();reject(error);}
  deadline=setTimeout(()=>request.destroy(new Error('Remote request deadline exceeded')),15000);
  request.on('timeout',()=>request.destroy(new Error('Remote request timed out.')));request.on('error',fail);options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();if(body)request.write(body);request.end();
 });
}
