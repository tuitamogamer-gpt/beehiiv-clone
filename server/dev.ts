import { serve } from '@hono/node-server';
import { handleRequest } from './runtime.js';
const port=Number(process.env.API_PORT||3001);
serve({fetch:handleRequest,hostname:'127.0.0.1',port},()=>console.log(`Newsletter API listening on http://127.0.0.1:${port}`));
