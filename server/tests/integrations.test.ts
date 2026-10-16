import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import type { Api, Principal, Variables } from '../contracts.js';
import { createSqliteStore } from '../core/store.js';
import { createServices } from '../core/services.js';
import { config } from '../core/config.js';
import { ApiError, hash, now } from '../core/http.js';
import { analyticsSummary, decryptWebhookSecret, deliverWebhook, encryptWebhookSecret, registerIntegrations } from '../modules/integrations.js';
import { registerContent } from '../modules/content.js';

async function fixture(t: TestContext) {
  const store = await createSqliteStore(':memory:'); t.after(() => store.close()); const services = createServices(store);
  const app: Api = new Hono<{ Variables: Variables }>();
  app.onError((error, c) => { if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.status as 400); throw error; });
  app.use('*', async (c, next) => { if (c.req.header('x-test-user')) c.set('principal', { userId: c.req.header('x-test-user')!, tenantId: c.req.header('x-test-tenant') || 'one', role: (c.req.header('x-test-role') || 'admin') as Principal['role'], ...(c.req.header('x-test-scopes') ? { apiKeyId: 'key', scopes: c.req.header('x-test-scopes')!.split(',') } : {}) }); await next(); });
  registerIntegrations(app, services); registerContent(app, services);
  const request = (path: string, options: { method?: string; body?: unknown; tenant?: string; role?: string; user?: string; scopes?: string; public?: boolean } = {}) => app.request(`http://localhost${path}`, { method: options.method || (options.body === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json', ...(!options.public ? { 'x-test-user': options.user || 'author', 'x-test-tenant': options.tenant || 'one', 'x-test-role': options.role || 'admin' } : {}), ...(options.scopes ? { 'x-test-scopes': options.scopes } : {}) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  await store.insert('__system__', 'tenant', { slug: 'one', tenantId: 'one' }, 'one'); await store.insert('one', 'publication', { slug: 'one', name: 'Example' });
  return { store, services, app, request };
}

test('webhook secrets are authenticated and bound to their tenant/endpoint', () => {
  const ciphertext = encryptWebhookSecret('secret-value', 'tenant:endpoint'); assert.ok(!ciphertext.includes('secret-value')); assert.equal(decryptWebhookSecret(ciphertext, 'tenant:endpoint'), 'secret-value');
  assert.throws(() => decryptWebhookSecret(ciphertext, 'other:endpoint'), /cannot be decrypted/);
  const pieces = ciphertext.split('.'); pieces[3] = 'AAAA'; assert.throws(() => decryptWebhookSecret(pieces.join('.'), 'tenant:endpoint'), /cannot be decrypted/);
});

test('webhooks reject private destinations, hide saved secrets, enforce admin and scopes', async t => {
  const { request, store } = await fixture(t);
  for (const url of ['http://8.8.8.8/hook', 'https://127.0.0.1/hook', 'https://[::1]/hook', 'https://169.254.169.254/latest/meta-data']) { const response = await request('/webhooks', { body: { name: 'Unsafe', url, events: ['*'] } }); assert.equal(response.status, 422); }
  assert.equal((await request('/webhooks', { role: 'member' })).status, 403);
  assert.equal((await request('/webhooks', { scopes: 'posts:read' })).status, 403);
  const created = await request('/webhooks', { body: { name: 'App', url: 'https://8.8.8.8/hook', events: ['subscriber.created'] } }); assert.equal(created.status, 201); const body = await created.json(); assert.match(body.secret, /^whsec_/); assert.equal(body.encryptedSecret, undefined);
  const list = await (await request('/webhooks')).json(); assert.equal(list.items[0].secret, undefined); assert.equal(list.items[0].encryptedSecret, undefined);
  const row = await store.get('one', 'webhook_endpoint', body.id); assert.ok(row?.data.encryptedSecret); assert.notEqual(row?.data.encryptedSecret, body.secret);
  assert.equal((await request(`/webhooks/${body.id}`, { tenant: 'two', method: 'PATCH', body: { enabled: false } })).status, 404);
  await request(`/webhooks/${body.id}`, { method: 'PATCH', body: { enabled: false } });
  const renamed = await (await request(`/webhooks/${body.id}`, { method: 'PATCH', body: { name: 'Renamed' } })).json(); assert.equal(renamed.enabled, false); assert.deepEqual(renamed.events, ['subscriber.created']); assert.equal(renamed.url, 'https://8.8.8.8/hook');
});

test('webhook worker signs authoritative events, records failure and retries through durable queue', async t => {
  const { store, services, request } = await fixture(t), endpointId = 'webhook', secret = 'test-signing-secret';
  await store.insert('one', 'webhook_endpoint', { name: 'Receiver', url: 'https://8.8.8.8/hook', events: ['subscriber.created'], enabled: true, payloadVersion: '2026-10-01', encryptedSecret: encryptWebhookSecret(secret, `one:${endpointId}`) }, endpointId);
  await services.emit('one', 'subscriber.created', { subscriberId: 'real-id' }); const queue = await store.list('__jobs__', 'job', { limit: 10 }); assert.equal(queue.items.length, 1); const queued = queue.items[0];
  let received = 0;
  await deliverWebhook(services, { ...queued, tenantId: 'one' }, async (_url, options) => { received++; const headers = new Headers(options?.headers), body = String(options?.body), timestamp = headers.get('webhook-timestamp'); assert.equal(headers.get('webhook-signature'), `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`); assert.equal(JSON.parse(body).data.subscriberId, 'real-id'); assert.equal(JSON.parse(body).api_version, '2026-10-01'); return new Response(null, { status: 204 }); });
  assert.equal(received, 1); assert.equal((await store.list('one', 'webhook_delivery')).items[0].data.status, 'delivered');
  await assert.rejects(deliverWebhook(services, { ...queued, tenantId: 'one' }, async () => new Response('bad', { status: 500 })), /HTTP 500/);
  const failed = (await store.list('one', 'webhook_delivery')).items.find(row => row.data.status === 'failed')!;
  assert.equal((await request(`/webhook-deliveries/${failed.id}/retry`, { body: {}, tenant: 'two' })).status, 404);
  assert.equal((await request(`/webhook-deliveries/${failed.id}/retry`, { body: {} })).status, 202);
  const endpoint = await store.get('one', 'webhook_endpoint', endpointId); await store.update('one', 'webhook_endpoint', endpointId, { ...endpoint!.data, enabled: false }, endpoint!.version);
  await deliverWebhook(services, { ...queued, tenantId: 'one' }, async () => { throw new Error('Disabled endpoint must never connect'); });
});

test('analytics uses persisted records, keeps currencies separate, and never invents delivery rates', async t => {
  const { store } = await fixture(t); const empty = await analyticsSummary(store, 'one'); assert.equal(empty.email.deliveryRate, null); assert.equal(empty.commerce.paidOrders, 0);
  await store.insert('one', 'subscriber', { status: 'Active', email: 'a@gmail.com', source: '__proto__', tier: 'Free' }, 'a');
  await store.insert('one', 'send_recipient', { subscriberId: 'a', providerId: 'provider', deliveredAt: now(), opened: true, clicked: false });
  await store.insert('one', 'order', { status: 'paid', currency: 'EUR', amountTotal: 1400 }); await store.insert('one', 'order', { status: 'paid', currency: 'USD', amountTotal: 2500 }); await store.insert('two', 'order', { status: 'paid', currency: 'USD', amountTotal: 100000 });
  const summary = await analyticsSummary(store, 'one'); assert.equal(summary.subscribers.bySource.__proto__, 1); assert.equal(summary.email.deliveryRate, 100); assert.equal(summary.email.engagementVerified, false); assert.equal(summary.commerce.revenueByCurrency.EUR, 1400); assert.equal(summary.commerce.revenueByCurrency.USD, 2500);
  await store.insert('one', 'website_event', { source: 'page_request' }); await store.insert('one', 'website_event', { source: 'page_view' }); assert.equal((await analyticsSummary(store, 'one')).website.recordedVisits, 1);
});

test('MCP hides disallowed tools and re-enters HTTP access controls', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/mcp', { public: true, body: { jsonrpc: '2.0', id: 1, method: 'initialize' } })).status, 401);
  const tools = await (await request('/mcp', { scopes: 'posts:read', body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })).json(); assert.deepEqual(tools.result.tools.map((tool: any) => tool.name), ['list_posts']);
  const forbidden = await (await request('/mcp', { scopes: 'posts:read', body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'analytics_summary', arguments: {} } } })).json(); assert.equal(forbidden.error.code, -32602);
  const allowed = await (await request('/mcp', { scopes: 'analytics:read', body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'analytics_summary', arguments: {} } } })).json(); assert.equal(allowed.result.isError, false); assert.equal(JSON.parse(allowed.result.content[0].text).subscribers.total, 0);
});

test('AI endpoints fail explicitly when provider keys are absent', async t => {
  const { request } = await fixture(t), previous = config.openaiApiKey; config.openaiApiKey = undefined; t.after(() => { config.openaiApiKey = previous; });
  assert.equal((await request('/ai/text', { body: { action: 'grammar', text: 'An newsletter' } })).status, 503);
  assert.equal((await request('/ai/images', { body: { prompt: 'A garden' } })).status, 503);
  assert.equal((await request('/ai/audio', { body: { text: 'Hello' } })).status, 503);
  assert.equal((await request('/ai/transcriptions', { body: { mediaId: 'audio' } })).status, 503);
});

test('templates sanitize HTML and preserve a single publication default', async t => {
  const { request } = await fixture(t);
  const first = await (await request('/templates', { body: { name: 'First', default: true, content: '<script>bad()</script><p>Text</p>' } })).json(); assert.ok(!first.content.includes('<script'));
  const second = await (await request('/templates', { body: { name: 'Second', default: true } })).json(); const list = await (await request('/templates')).json(); assert.deepEqual(list.items.filter((row: any) => row.default).map((row: any) => row.id), [second.id]);
  assert.equal((await request(`/templates/${first.id}/duplicate`, { body: {}, tenant: 'two' })).status, 404);
  assert.equal((await request('/templates', { role: 'contributor', body: { name: 'Forbidden' } })).status, 403);
  const configured = await (await request('/templates', { body: { name: 'Custom', content: '<p>Keep this content</p>', default: true, channel: 'email', styles: { background: '#112233', color: '#445566', accent: '#778899', font: 'Georgia', fontSize: 22, spacing: 40 } } })).json();
  const renamed = await (await request(`/templates/${configured.id}`, { method: 'PATCH', body: { name: 'Custom renamed' } })).json(); assert.equal(renamed.content, configured.content); assert.deepEqual(renamed.styles, configured.styles); assert.equal(renamed.default, true); assert.equal(renamed.channel, 'email');
  const styled = await (await request(`/templates/${configured.id}`, { method: 'PATCH', body: { styles: { accent: '#ff0000' } } })).json(); assert.equal(styled.styles.accent, '#ff0000'); assert.equal(styled.styles.background, '#112233'); assert.equal(styled.styles.font, 'Georgia');
});

test('page title PATCH preserves content, paywall, SEO and robots flags', async t => {
  const { request, app, store } = await fixture(t);
  const page = await (await request('/website/pages', { body: { title: 'Original', slug: 'preserved', content: '<p>Saved body</p>', description: 'Saved summary', seoTitle: 'Custom title', seoDescription: 'Custom metadata', access: 'premium', noIndex: true } })).json();
  const edited = await (await request(`/website/pages/${page.id}`, { method: 'PATCH', body: { title: 'Renamed' } })).json(); assert.deepEqual(edited.draft, { ...page.draft, title: 'Renamed' });
  const publicPage = await (await request('/website/pages', { body: { title: 'Visit', slug: 'visit', content: '<p>Visit</p>' } })).json(); await request(`/website/pages/${publicPage.id}/publish`, { body: {} });
  await app.request('http://localhost/public/one/pages/visit?secret=hidden', { headers: { referer: 'https://search.example/result?private_token=hidden', 'user-agent': 'Mozilla/5.0' } });
  const event = (await store.list('one', 'website_event')).items[0]; assert.equal(event.data.source, 'page_request'); assert.equal(event.data.referrerHost, 'search.example'); assert.equal(event.data.path, '/pages/visit'); assert.ok(!JSON.stringify(event.data).includes('hidden')); assert.equal((await store.list('one', 'website_daily')).items[0].data.views, 1);
});

test('website draft edits stay private until publication, revisions restore drafts, and slugs stay unique', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/website/pages', { role: 'contributor', body: { title: 'No', slug: 'no' } })).status, 403);
  const created = await (await request('/website/pages', { body: { title: 'Initial', slug: 'welcome', content: '<p>First edition</p><script>alert(1)</script>' } })).json();
  assert.equal((await request('/public/one/pages/welcome', { public: true })).status, 404);
  const published = await (await request(`/website/pages/${created.id}/publish`, { body: {} })).json();
  const html = await (await request('/public/one/pages/welcome', { public: true })).text(); assert.ok(html.includes('First edition')); assert.ok(!html.includes('<script>'));
  const edited = await (await request(`/website/pages/${created.id}`, { method: 'PATCH', body: { slug: 'changed', content: '<p>Private edit</p>', version: published.version } })).json(); assert.equal(edited.draft.slug, 'changed');
  assert.ok(!(await (await request('/public/one/pages/welcome', { public: true })).text()).includes('Private edit'));
  assert.equal((await request('/website/pages', { body: { title: 'Collision', slug: 'welcome' } })).status, 409);
  assert.equal((await request(`/website/pages/${created.id}`, { method: 'PATCH', body: { title: 'Stale', version: published.version } })).status, 409);
  const revisions = await (await request(`/website/pages/${created.id}/revisions`)).json(); const original = revisions.items.find((row: any) => row.snapshot.draft.content.includes('First edition'));
  const restored = await (await request(`/website/pages/${created.id}/restore`, { body: { revisionId: original.id, version: edited.version } })).json(); assert.ok(restored.draft.content.includes('First edition'));
  assert.equal((await request(`/website/pages/${created.id}`, { tenant: 'two' })).status, 404);
});

test('premium website pages never expose content to anonymous visitors', async t => {
  const { request } = await fixture(t); const page = await (await request('/website/pages', { body: { title: 'Premium', slug: 'paid', access: 'premium', content: '<p>Private paid content</p>' } })).json(); await request(`/website/pages/${page.id}/publish`, { body: {} });
  const response = await request('/public/one/pages/paid', { public: true }); assert.equal(response.status, 401); assert.ok(!(await response.text()).includes('Private paid content'));
  assert.equal((await request('/public/one/pages/paid', { scopes: 'subscribers:read' })).status, 403);
  assert.equal((await request('/public/one/pages/paid', { scopes: 'content:read' })).status, 200);
});

test('redirects reject open redirects and cycles', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/website/redirects', { body: { from: '/old', to: '//evil.com' } })).status, 422);
  assert.equal((await request('/website/redirects', { body: { from: '/old', to: '/new' } })).status, 201);
  assert.equal((await request('/website/redirects', { body: { from: '/new', to: '/old' } })).status, 422);
});

test('survey answers bind to active subscriber tokens and cannot be replayed or forged', async t => {
  const { request, store } = await fixture(t); await store.insert('one', 'subscriber', { email: 'reader@example.com', status: 'Active' }, 'reader');
  const created = await (await request('/polls', { body: { title: 'Next topic', active: true, questions: [{ id: 'topic', title: 'Choose a topic', type: 'single', options: [{ id: 'science', label: 'Science' }, { id: 'art', label: 'Art' }] }] } })).json();
  const link = await (await request(`/polls/${created.id}/response-link`, { body: { subscriberId: 'reader' } })).json(); assert.equal(typeof link.token, 'string');
  const saved = await store.get('one', 'survey_grant', hash(link.token)); assert.equal(saved?.data.subscriberId, 'reader'); assert.ok(!JSON.stringify(saved?.data).includes(link.token));
  const path = `/public/one/polls/${created.id}/responses`;
  assert.equal((await request(path, { public: true, body: { token: 'forged-token-that-is-long-enough', answers: { topic: 'science' } } })).status, 401);
  assert.equal((await request(path, { public: true, body: { token: link.token, answers: { topic: 'invalid' } } })).status, 422);
  assert.equal((await request(path, { public: true, body: { token: link.token, answers: { topic: 'art' }, subscriberId: 'someone-else' } })).status, 422);
  assert.equal((await request(path, { public: true, body: { token: link.token, answers: { topic: 'art' } } })).status, 201);
  assert.equal((await request(path, { public: true, body: { token: link.token, answers: { topic: 'science' } } })).status, 409);
  const results = await (await request(`/polls/${created.id}/results`)).json(); assert.equal(results.totalResponses, 1); assert.equal(results.questions[0].options.find((row: any) => row.id === 'art').count, 1);
  assert.equal((await request(`/polls/${created.id}/responses`, { tenant: 'two' })).status, 404);
});

test('editorial comments prevent cross-post threads and author impersonation', async t => {
  const { request, store } = await fixture(t); await store.insert('one', 'post', { title: 'First' }, 'first'); await store.insert('one', 'post', { title: 'Second' }, 'second');
  const comment = await (await request('/posts/first/comments', { body: { body: 'Please check this', authorId: 'forged' } })).json(); assert.equal(comment.error.code, 'validation_error');
  const actual = await (await request('/posts/first/comments', { body: { body: 'Please check this' } })).json();
  assert.equal((await request('/posts/second/comments', { body: { body: 'Cross-post', parentId: actual.id } })).status, 422);
  assert.equal((await request(`/comments/${actual.id}`, { user: 'other', body: { body: 'Altered', version: actual.version }, method: 'PATCH' })).status, 403);
});
