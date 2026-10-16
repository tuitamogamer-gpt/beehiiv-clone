import { getStore } from './core/store.js';
import { createServices } from './core/services.js';
import { bootstrapAdmin } from './modules/auth.js';
import { createApp } from './app.js';

const command=process.argv[2];
const store=await getStore();
try{
 if(command==='migrate')console.log('Database schema is ready (migration 1).');
 else if(command==='bootstrap'){
  const {ADMIN_EMAIL:email,ADMIN_PASSWORD:password,ADMIN_NAME:name,PUBLICATION_NAME:publicationName}=process.env;
  if(!email||!password||!name||!publicationName)throw new Error('Set ADMIN_EMAIL, ADMIN_PASSWORD (12+ characters), ADMIN_NAME and PUBLICATION_NAME in a private environment file.');
  const result=await bootstrapAdmin(store,{email,password,name,publicationName});console.log(JSON.stringify(result,null,2));
 }else if(command==='worker'){
  const services=createServices(store);createApp(services);const once=process.argv.includes('--once');
  do{console.log(JSON.stringify(await services.runJobs(100)));if(once)break;await new Promise(resolve=>setTimeout(resolve,1000));}while(true);
 }else throw new Error('Usage: npm run db:migrate | npm run db:bootstrap | npm run worker -- --once');
}finally{await store.close();}
