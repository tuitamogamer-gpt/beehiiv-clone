import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Api, Ctx, Principal, RecordData, Services, Store, Stored } from '../contracts.js';
import { config } from '../core/config.js';
import { ApiError, audit, flatten, hash, id, jsonBody, now, pagination, principal, randomToken, requireRole, requireScope } from '../core/http.js';
import { safeFetch, validatePublicUrl } from '../core/network.js';
import { rateLimit } from '../core/security.js';
import { allRecords } from '../core/store.js';
import { readMedia, saveMedia } from './media.js';

function encryptionKey() {
  if (!config.sessionSecret || config.sessionSecret.length < 32) throw new ApiError(503, 'encryption_not_configured', 'Configure a stable SESSION_SECRET before creating webhook endpoints.');
  return createHash('sha256').update(`webhook-encryption:v1:${config.sessionSecret}`).digest();
}
export function encryptWebhookSecret(secret: string, context: string): string {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
export function decryptWebhookSecret(value: string, context: string): string {
  try {
    const [version, nonce, tag, encrypted] = value.split('.');
    if (version !== 'v1' || !encrypted) throw new Error('Invalid encrypted secret');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(nonce, 'base64url'));
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString();
  } catch { throw new ApiError(503, 'webhook_secret_unavailable', 'The webhook secret cannot be decrypted. Restore the signing configuration or rotate this endpoint secret.'); }
}
export function signWebhook(secret: string, timestamp: string, payload: string) { return `v1=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`; }
const endpointSchema = z.object({ name: z.string().trim().min(1).max(160), url: z.string().url().max(2048), events: z.array(z.string().regex(/^(\*|[a-z][a-z0-9_.]{1,99})$/)).min(1).max(100), enabled: z.boolean().default(true), payloadVersion: z.literal('2026-10-01').default('2026-10-01') }).strict();
const endpointPatchSchema = z.object({ name: endpointSchema.shape.name.optional(), url: endpointSchema.shape.url.optional(), events: endpointSchema.shape.events.optional(), enabled: z.boolean().optional(), payloadVersion: z.literal('2026-10-01').optional(), version: z.number().int().positive().optional() }).strict();
function endpointView(row: Stored) { const { encryptedSecret: _, ...data } = row.data; return { ...data, id: row.id, version: row.version, createdAt: row.createdAt }; }

export async function deliverWebhook(services: Services, job: Stored, transport: typeof safeFetch = safeFetch): Promise<void> {
  const { endpointId, eventId } = job.data.payload;
  const endpoint = await services.store.get(job.tenantId, 'webhook_endpoint', endpointId);
  if (!endpoint || !endpoint.data.enabled) return;
  const event = await services.store.get(job.tenantId, 'event', eventId);
  if (!event) throw new ApiError(404, 'event_missing', 'The webhook event no longer exists.');
  if (!endpoint.data.events.includes('*') && !endpoint.data.events.includes(event.data.type)) return;
  const context = `${job.tenantId}:${endpoint.id}`;
  const secret = decryptWebhookSecret(endpoint.data.encryptedSecret, context);
  const payload = JSON.stringify({ id: event.id, type: event.data.type, api_version: endpoint.data.payloadVersion, created_at: event.createdAt, publication_id: job.tenantId, data: event.data.data });
  const timestamp = String(Math.floor(Date.now() / 1000));
  let status: number | null = null, error: string | null = null;
  try {
    const response = await transport(endpoint.data.url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Newsletter-Webhooks/1.0', 'webhook-id': event.id, 'webhook-timestamp': timestamp, 'webhook-signature': signWebhook(secret, timestamp, payload) }, body: payload });
    status = response.status;
    if (!response.ok) error = `Destination returned HTTP ${status}.`;
  } catch (cause) { error = cause instanceof ApiError ? cause.message : 'The destination could not be reached.'; }
  // A separate row per attempt keeps an honest record, even for automatic retries.
  await services.store.insert(job.tenantId, 'webhook_delivery', { endpointId, eventId, jobId: job.id, attempt: job.data.attempts || 1, status: error ? 'failed' : 'delivered', statusCode: status, error, attemptedAt: now() });
  if (error) throw new ApiError(502, 'webhook_delivery_failed', error);
}

export async function analyticsSummary(store: Store, tenantId: string) {
  const [subscribers, recipients, orders, events] = await Promise.all(['subscriber', 'send_recipient', 'order', 'website_event'].map(kind => allRecords(store, tenantId, kind)));
  const sources: Record<string, number> = Object.create(null), mailboxProviders: Record<string, RecordData> = Object.create(null), revenueByCurrency: Record<string, number> = Object.create(null);
  for (const row of subscribers) sources[row.data.source || 'Unknown'] = (sources[row.data.source || 'Unknown'] || 0) + 1;
  let accepted = 0, delivered = 0, uniqueOpens = 0, uniqueClicks = 0, botClicks = 0, bounces = 0, complaints = 0;
  const subscriberMap = new Map(subscribers.map(row => [row.id, row.data]));
  for (const row of recipients) {
    const r = row.data, domain = String(subscriberMap.get(r.subscriberId)?.email || '').split('@')[1] || 'Unknown';
    const provider = mailboxProviders[domain] ||= { accepted: 0, delivered: 0, bounced: 0, complained: 0 };
    if (r.providerId) { accepted++; provider.accepted++; }
    if (r.deliveredAt) { delivered++; provider.delivered++; }
    if (r.opened) uniqueOpens++;
    if (r.clicked) uniqueClicks++;
    botClicks += Number(r.botClickCount || 0);
    if (r.deliveryStatus === 'Bounced' || r.status === 'Bounced') { bounces++; provider.bounced++; }
    if (r.complainedAt) { complaints++; provider.complained++; }
  }
  const settled = orders.filter(row => ['paid', 'partially_refunded', 'refunded'].includes(row.data.status));
  for (const row of settled) { const currency = String(row.data.currency || 'USD').toUpperCase(), charged = Number(row.data.amountTotal ?? 0), refunded = Number(row.data.amountRefunded ?? (row.data.status === 'refunded' ? charged : 0)); revenueByCurrency[currency] = (revenueByCurrency[currency] || 0) + Math.max(0, charged - refunded); }
  return { asOf: now(), subscribers: { total: subscribers.length, active: subscribers.filter(row => row.data.status === 'Active').length, premium: subscribers.filter(row => row.data.tier === 'Premium').length, bySource: sources }, email: { accepted, delivered, bounces, complaints, uniqueOpens, uniqueClicks, botClicks, openRate: accepted ? uniqueOpens / accepted * 100 : 0, clickRate: accepted ? uniqueClicks / accepted * 100 : 0, deliveryRate: accepted ? delivered / accepted * 100 : null, engagementVerified: false, byMailboxDomain: mailboxProviders }, commerce: { revenueByCurrency, amountUnit: 'minor_currency_unit', revenueDefinition: 'confirmed_charges_less_recorded_refunds_before_processor_fees', paidOrders: settled.length }, website: { recordedVisits: events.filter(row => row.data.source === 'page_request').length, source: 'first_party_page_requests', includesUnidentifiedBots: true }, limitations: ['Opens can include mailbox privacy proxies.', 'Bot click filtering is heuristic, not third-party verified.', 'This summary is capped at 20,000 records per collection; use paginated exports for larger publications.'] };
}

type McpTool = { name: string; description: string; scope: string; roles?: string[]; inputSchema: RecordData; schema: z.ZodType; method: string; route: (args: any) => string; body?: (args: any) => unknown };
const noArgs = z.object({}).strict(), cursorArgs = z.object({ cursor: z.string().max(1000).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict();
const listSchema = { type: 'object', properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false };
const listPath = (path: string, args: any) => `${path}?${new URLSearchParams({ limit: String(args.limit), ...(args.cursor ? { cursor: args.cursor } : {}) })}`;
const mcpTools: McpTool[] = [
  { name: 'analytics_summary', description: 'Read actual subscriber, delivery, engagement and sales metrics.', scope: 'analytics:read', roles: ['admin', 'member'], inputSchema: { type: 'object', properties: {}, additionalProperties: false }, schema: noArgs, method: 'GET', route: () => '/analytics/summary' },
  { name: 'list_posts', description: 'List this publication’s posts with cursor pagination.', scope: 'posts:read', inputSchema: listSchema, schema: cursorArgs, method: 'GET', route: a => listPath('/posts', a) },
  { name: 'list_subscribers', description: 'Read subscribers from the authenticated publication.', scope: 'subscribers:read', roles: ['admin', 'member'], inputSchema: listSchema, schema: cursorArgs, method: 'GET', route: a => listPath('/subscribers', a) },
  { name: 'subscriber_history', description: 'Read a subscriber and their recorded engagement events.', scope: 'subscribers:read', roles: ['admin', 'member'], inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false }, schema: z.object({ id: z.string().min(1).max(200) }).strict(), method: 'GET', route: a => `/subscribers/${encodeURIComponent(a.id)}` },
  { name: 'create_post_draft', description: 'Create a sanitized draft. This does not send a newsletter.', scope: 'posts:write', inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false }, schema: z.object({ title: z.string().min(1).max(300), content: z.string().max(100000).default('<p></p>') }).strict(), method: 'POST', route: () => '/posts', body: a => a },
  { name: 'list_segments', description: 'Read available subscriber segments.', scope: 'segments:read', roles: ['admin', 'member'], inputSchema: listSchema, schema: cursorArgs, method: 'GET', route: a => listPath('/segments', a) },
  { name: 'list_automations', description: 'Read publication automation drafts and live states.', scope: 'automations:read', inputSchema: listSchema, schema: cursorArgs, method: 'GET', route: a => listPath('/automations', a) },
];
function allowed(p: Principal, tool: McpTool) { return (!tool.roles || tool.roles.includes(p.role)) && (!p.apiKeyId || p.scopes?.includes(tool.scope) || p.scopes?.includes('*')); }
async function aiText(c: Ctx, services: Services) {
  const p = principal(c); requireScope(c, 'ai:write');
  const input = await jsonBody(c, z.object({ action: z.enum(['rewrite', 'translate', 'grammar', 'draft']), text: z.string().min(1).max(20000), language: z.string().min(2).max(80).optional(), instruction: z.string().max(1000).optional() }).strict());
  if (!config.openaiApiKey) throw new ApiError(503, 'ai_not_configured', 'Set OPENAI_API_KEY to activate AI writing.');
  if (input.action === 'translate' && !input.language) throw new ApiError(422, 'language_required', 'Choose the translation language.');
  await rateLimit(services, `ai:${p.tenantId}`, 30, 3600);
  const instructions = { rewrite: 'Rewrite the supplied newsletter prose clearly. Preserve factual meaning.', translate: `Translate the supplied text into ${input.language}.`, grammar: 'Correct spelling and grammar in the supplied text while preserving meaning.', draft: 'Write a newsletter draft following the supplied brief. Do not invent factual claims.' };
  const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${config.openaiApiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini', instructions: `${instructions[input.action]} Return only the edited plain text. ${input.instruction || ''}`, input: input.text, max_output_tokens: 4000, store: false }), signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new ApiError(response.status === 429 ? 429 : 502, 'ai_provider_error', 'The AI provider could not complete this request.');
  const data = await response.json() as RecordData;
  const text = (data.output || []).flatMap((item: RecordData) => item.content || []).filter((item: RecordData) => item.type === 'output_text').map((item: RecordData) => item.text).join('\n');
  if (!text) throw new ApiError(502, 'ai_empty_response', 'The AI provider did not return text.');
  await audit(services, p, 'ai.text', { action: input.action, providerResponseId: data.id, usage: data.usage || null });
  return c.json({ text, usage: data.usage || null, provider: 'openai' });
}

export function registerIntegrations(app: Api, services: Services): void {
  const { store } = services;
  services.registerJob('webhook.deliver', job => deliverWebhook(services, job));
  app.get('/webhooks', async c => { const p = requireRole(c, 'admin'); requireScope(c, 'integrations:read'); const page = await store.list(p.tenantId, 'webhook_endpoint', pagination(c)); return c.json({ items: page.items.map(endpointView), nextCursor: page.nextCursor }); });
  app.post('/webhooks', async c => {
    const p = requireRole(c, 'admin'); requireScope(c, 'integrations:write'); const input = await jsonBody(c, endpointSchema); await validatePublicUrl(input.url);
    const endpointId = id(), secret = `whsec_${randomToken()}`;
    const row = await store.insert(p.tenantId, 'webhook_endpoint', { ...input, events: [...new Set(input.events)], encryptedSecret: encryptWebhookSecret(secret, `${p.tenantId}:${endpointId}`) }, endpointId);
    await audit(services, p, 'webhook.create', { endpointId }); return c.json({ ...endpointView(row), secret }, 201);
  });
  app.patch('/webhooks/:id', async c => {
    const p = requireRole(c, 'admin'); requireScope(c, 'integrations:write'); const { version, ...input } = await jsonBody(c, endpointPatchSchema); if (input.url) await validatePublicUrl(input.url);
    const current = await store.get(p.tenantId, 'webhook_endpoint', c.req.param('id')); if (!current) throw new ApiError(404, 'not_found', 'Webhook endpoint not found.');
    const row = await store.update(p.tenantId, 'webhook_endpoint', current.id, { ...current.data, ...input }, version ?? current.version); await audit(services, p, 'webhook.update', { endpointId: row.id }); return c.json(endpointView(row));
  });
  app.post('/webhooks/:id/rotate-secret', async c => {
    const p = requireRole(c, 'admin'); requireScope(c, 'integrations:write'); const current = await store.get(p.tenantId, 'webhook_endpoint', c.req.param('id')); if (!current) throw new ApiError(404, 'not_found', 'Webhook endpoint not found.'); const secret = `whsec_${randomToken()}`;
    await store.update(p.tenantId, 'webhook_endpoint', current.id, { ...current.data, encryptedSecret: encryptWebhookSecret(secret, `${p.tenantId}:${current.id}`) }, current.version); await audit(services, p, 'webhook.secret.rotate', { endpointId: current.id }); return c.json({ secret });
  });
  app.delete('/webhooks/:id', async c => { const p = requireRole(c, 'admin'); requireScope(c, 'integrations:write'); if (!await store.remove(p.tenantId, 'webhook_endpoint', c.req.param('id'))) throw new ApiError(404, 'not_found', 'Webhook endpoint not found.'); await audit(services, p, 'webhook.delete', { endpointId: c.req.param('id') }); return c.body(null, 204); });
  app.get('/webhooks/:id/deliveries', async c => { const p = requireRole(c, 'admin'); requireScope(c, 'integrations:read'); if (!await store.get(p.tenantId, 'webhook_endpoint', c.req.param('id'))) throw new ApiError(404, 'not_found', 'Webhook endpoint not found.'); const page = await store.list(p.tenantId, 'webhook_delivery', { ...pagination(c), filters: { endpointId: c.req.param('id') }, order: 'desc' }); return c.json({ items: page.items.map(flatten), nextCursor: page.nextCursor }); });
  app.post('/webhook-deliveries/:id/retry', async c => {
    const p = requireRole(c, 'admin'); requireScope(c, 'integrations:write'); await rateLimit(services, `webhook-retry:${p.tenantId}`, 60, 60);
    const delivery = await store.get(p.tenantId, 'webhook_delivery', c.req.param('id')); if (!delivery) throw new ApiError(404, 'not_found', 'Webhook delivery not found.');
    const endpoint = await store.get(p.tenantId, 'webhook_endpoint', delivery.data.endpointId); if (!endpoint?.data.enabled) throw new ApiError(409, 'endpoint_disabled', 'Enable the webhook endpoint before retrying.');
    const job = await services.enqueue({ type: 'webhook.deliver', tenantId: p.tenantId, payload: { endpointId: endpoint.id, eventId: delivery.data.eventId }, maxAttempts: 10 }); await audit(services, p, 'webhook.retry', { deliveryId: delivery.id, jobId: job.id }); return c.json({ jobId: job.id, status: 'queued' }, 202);
  });
  app.get('/analytics/summary', async c => { const p = requireRole(c, 'admin', 'member'); requireScope(c, 'analytics:read'); return c.json(await analyticsSummary(store, p.tenantId)); });
  app.get('/analytics/events', async c => { const p = requireRole(c, 'admin', 'member'); requireScope(c, 'analytics:read'); const page = await store.list(p.tenantId, 'email_event', { ...pagination(c), ...(c.req.query('postId') ? { filters: { postId: c.req.query('postId')! } } : {}) }); return c.json({ items: page.items.map(flatten), nextCursor: page.nextCursor }); });
  app.post('/ai/text', c => aiText(c, services));
  const aiMediaReady = (c: Ctx) => { const p = principal(c); requireScope(c, 'ai:write'); requireScope(c, 'media:write'); if (!config.openaiApiKey) throw new ApiError(503, 'ai_not_configured', 'Set OPENAI_API_KEY to activate AI media.'); if (config.production && !config.blobToken) throw new ApiError(503, 'media_not_configured', 'Configure private Blob storage before generating media.'); return p; };
  app.post('/ai/images', async c => {
    const p = aiMediaReady(c), input = await jsonBody(c, z.object({ prompt: z.string().trim().min(1).max(3000), name: z.string().min(1).max(150).default('ai-image.webp') }).strict()); await rateLimit(services, `ai-images:${p.tenantId}`, 10, 3600);
    const response = await fetch('https://api.openai.com/v1/images/generations', { method: 'POST', headers: { authorization: `Bearer ${config.openaiApiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', prompt: input.prompt, n: 1, size: '1024x1024', quality: 'low', output_format: 'webp' }), signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw new ApiError(response.status === 429 ? 429 : 502, 'ai_provider_error', 'The image provider could not complete this request.');
    const result = await response.json() as RecordData, encoded = result.data?.[0]?.b64_json; if (typeof encoded !== 'string' || encoded.length > 6_000_000) throw new ApiError(502, 'ai_invalid_image', 'The provider image is missing or exceeds the supported upload size.');
    const row = await saveMedia(services, p.tenantId, p.userId, new Uint8Array(Buffer.from(encoded, 'base64')), input.name, 'image/webp'); await audit(services, p, 'ai.image', { mediaId: row.id }); return c.json({ mediaId: row.id, mimeType: row.data.mimeType, downloadUrl: `/api/media/${row.id}/content` }, 201);
  });
  app.post('/ai/audio', async c => {
    const p = aiMediaReady(c), input = await jsonBody(c, z.object({ text: z.string().trim().min(1).max(4096), voice: z.enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']).default('alloy'), name: z.string().min(1).max(150).default('newsletter-audio.mp3') }).strict()); await rateLimit(services, `ai-audio:${p.tenantId}`, 20, 3600);
    const response = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { authorization: `Bearer ${config.openaiApiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.OPENAI_AUDIO_MODEL || 'tts-1', input: input.text, voice: input.voice, response_format: 'mp3' }), signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw new ApiError(response.status === 429 ? 429 : 502, 'ai_provider_error', 'The speech provider could not complete this request.');
    if (Number(response.headers.get('content-length') || 0) > 4 * 1024 * 1024) throw new ApiError(413, 'audio_size', 'Generated audio exceeds the 4 MB media limit.');
    const row = await saveMedia(services, p.tenantId, p.userId, new Uint8Array(await response.arrayBuffer()), input.name, 'audio/mpeg'); await audit(services, p, 'ai.audio', { mediaId: row.id }); return c.json({ mediaId: row.id, mimeType: row.data.mimeType, downloadUrl: `/api/media/${row.id}/content`, disclosure: 'This audio was generated by AI.' }, 201);
  });
  app.post('/ai/transcriptions', async c => {
    const p = aiMediaReady(c); requireScope(c, 'media:read'); const input = await jsonBody(c, z.object({ mediaId: z.string().min(1).max(200), language: z.string().regex(/^[a-z]{2}$/).optional() }).strict()); const record = await store.get(p.tenantId, 'media', input.mediaId); if (!record || !String(record.data.mimeType).startsWith('audio/')) throw new ApiError(422, 'audio_required', 'Select an audio file from this publication’s media library.'); await rateLimit(services, `ai-transcription:${p.tenantId}`, 20, 3600);
    const file = await readMedia(store, p.tenantId, record.id), bytes = file.body instanceof Uint8Array ? file.body : new Uint8Array(await new Response(file.body).arrayBuffer()); if (bytes.length > 4 * 1024 * 1024) throw new ApiError(413, 'audio_size', 'Transcription is limited to 4 MB audio files.');
    const form = new FormData(); form.append('file', new Blob([bytes as BlobPart], { type: file.contentType }), file.filename); form.append('model', process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1'); if (input.language) form.append('language', input.language);
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${config.openaiApiKey}` }, body: form, signal: AbortSignal.timeout(45000) }); if (!response.ok) throw new ApiError(response.status === 429 ? 429 : 502, 'ai_provider_error', 'The transcription provider could not complete this request.'); const result = await response.json() as RecordData; if (typeof result.text !== 'string' || result.text.length > 100000) throw new ApiError(502, 'ai_invalid_transcription', 'The provider returned an invalid transcription.'); const row = await store.insert(p.tenantId, 'transcription', { mediaId: record.id, text: result.text, createdBy: p.userId, provider: 'openai' }); return c.json(flatten(row), 201);
  });
  app.post('/mcp', async c => {
    const p = principal(c); await rateLimit(services, `mcp:${p.tenantId}:${p.userId}`, 120, 60);
    const request = await jsonBody(c, z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(200), z.number(), z.null()]).optional(), method: z.string().max(100), params: z.record(z.string(), z.unknown()).optional() }).strict());
    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id: request.id ?? null, result });
    if (request.method === 'notifications/initialized') return c.body(null, 202);
    if (request.method === 'initialize') return reply({ protocolVersion: '2025-03-26', serverInfo: { name: 'newsletter-workspace', version: '1.0.0' }, capabilities: { tools: {} } });
    if (request.method === 'ping') return reply({});
    if (request.method === 'tools/list') return reply({ tools: mcpTools.filter(tool => allowed(p, tool)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (request.method !== 'tools/call') return c.json({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32601, message: 'Method not found' } });
    const tool = mcpTools.find(item => item.name === request.params?.name);
    if (!tool || !allowed(p, tool)) return c.json({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32602, message: 'Tool unavailable for this account or API scope.' } });
    const parsed = tool.schema.safeParse(request.params?.arguments || {});
    if (!parsed.success) return c.json({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32602, message: 'Invalid tool arguments.' } });
    // Re-enter the same HTTP router and authorization middleware; no privileged MCP bypass.
    const prefix = c.req.path.slice(0, -'/mcp'.length), url = new URL(prefix + tool.route(parsed.data), c.req.url);
    const headers = new Headers(c.req.raw.headers); headers.delete('content-length'); headers.set('content-type', 'application/json');
    const response = await app.request(url.toString(), { method: tool.method, headers, ...(tool.body ? { body: JSON.stringify(tool.body(parsed.data)) } : {}) });
    return reply({ content: [{ type: 'text', text: await response.text() }], isError: !response.ok });
  });
}
