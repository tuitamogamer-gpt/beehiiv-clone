import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Variables } from './contracts.js';
import type { RuntimeServices } from './core/services.js';
import { ApiError, id } from './core/http.js';
import { config, configurationStatus } from './core/config.js';
import { rateLimit, secureEqual } from './core/security.js';
import { authenticate, registerAuth } from './modules/auth.js';
import { registerAudience } from './modules/audience.js';
import { registerAutomations } from './modules/automations.js';
import { registerDelivery } from './modules/delivery.js';
import { registerCommerce } from './modules/commerce.js';
import { registerCommunity } from './modules/community.js';
import { registerPodcasts } from './modules/podcasts.js';
import { registerReaders } from './modules/readers.js';
import { registerGrowth } from './modules/growth.js';
import { registerMedia } from './modules/media.js';
import { registerWorkspace } from './modules/workspace.js';
import { registerIntegrations } from './modules/integrations.js';
import { registerContent } from './modules/content.js';

export function createApp(services:RuntimeServices){
 const app=new Hono<{Variables:Variables}>().basePath('/api');
 app.use('*',async(c,next)=>{c.set('requestId',id());c.header('X-Request-Id',c.get('requestId'));c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');await next();});
 app.use('*',bodyLimit({maxSize:4*1024*1024+32768,onError:()=>{throw new ApiError(413,'payload_too_large','The maximum request size is 4 MB.');}}));
 app.get('/health',c=>c.json({ok:true,service:'newsletter-backend'}));
 app.get('/status',c=>c.json({capabilities:configurationStatus(),service:'newsletter-backend',version:1}));
 app.use('*',authenticate(services));
 app.use('*',async(c,next)=>{
  if(!['GET','HEAD','OPTIONS'].includes(c.req.method)&&!c.req.path.startsWith('/api/public/')&&!['/api/webhooks/resend','/api/webhooks/stripe'].includes(c.req.path)&&c.req.path!=='/api/jobs/run'){
   const p=c.get('principal');const origin=c.req.header('origin');
   if(!p?.apiKeyId){
    const expected=new URL(config.appUrl).origin;
    if(origin&&origin!==expected||!origin&&c.req.header('cookie'))throw new ApiError(403,'invalid_origin','Use the application origin for session requests.');
    if(c.req.header('sec-fetch-site')==='cross-site')throw new ApiError(403,'invalid_origin','Cross-site session requests are not allowed.');
   }
  }
  const p=c.get('principal');if(p)await rateLimit(services,`api:${p.apiKeyId||p.sessionId||p.userId}`,600,60);
  await next();
 });
 const run=async(c:any)=>{const token=c.req.header('authorization')||'';if(!config.cronSecret||!secureEqual(token,`Bearer ${config.cronSecret}`))throw new ApiError(401,'invalid_cron_secret','A valid scheduler secret is required.');return c.json(await services.runJobs(50));};
 app.get('/jobs/run',run);app.post('/jobs/run',run);
 registerAuth(app,services);registerWorkspace(app,services);registerAudience(app,services);registerAutomations(app,services);registerDelivery(app,services);registerCommerce(app,services);registerCommunity(app,services);registerPodcasts(app,services);registerReaders(app,services);registerMedia(app,services);registerIntegrations(app,services);registerContent(app,services);registerGrowth(app,services);
 app.notFound(c=>c.json({error:{code:'not_found',message:'API route not found.'}},404));
 app.onError((error,c)=>{const known=error instanceof ApiError;if(!known)console.error(JSON.stringify({requestId:c.get('requestId'),error:error.name,message:config.production?'Unhandled request failure':error.message}));return c.json({error:{code:known?error.code:'internal_error',message:known?error.message:'The request could not be completed.',...(known&&error.details?{details:error.details}:{}),requestId:c.get('requestId')}},(known?error.status:500) as any);});
 return app;
}
