import { getRequestListener } from '@hono/node-server';
import { handleRequest } from '../server/runtime.js';
// Keep provider webhooks byte-for-byte intact for signature verification.
export const config = { api: { bodyParser: false } };
export default getRequestListener(handleRequest, { overrideGlobalObjects: false });
