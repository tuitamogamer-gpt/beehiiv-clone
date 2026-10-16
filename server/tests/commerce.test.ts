import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import Stripe from 'stripe';
import type { Api, Principal, Variables } from '../contracts.js';
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://newsletter.example.com';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local_signature_test_only';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;
const { createSqliteStore } = await import('../core/store.js');
const { createServices } = await import('../core/services.js');
const { ApiError, hash, principal } = await import('../core/http.js');
const { registerCommerce, applyStripeEvent, hasPaidEntitlement } = await import('../modules/commerce.js');
const { saveMedia } = await import('../modules/media.js');
const { registerReaders } = await import('../modules/readers.js');
const { authenticate } = await import('../modules/auth.js');
const { config } = await import('../core/config.js');
const { registerCommunity } = await import('../modules/community.js');
const { registerPodcasts } = await import('../modules/podcasts.js');
const signing = new Stripe('sk_local_signature_test_only');
const administrator: Principal = { userId: 'admin', tenantId: 'tenant-a', role: 'admin', sessionId: 'test-session' };
async function fixture(t: TestContext, path = ':memory:') {
 const store = await createSqliteStore(path); let closed = false; t.after(async () => { if (!closed) await store.close(); });
 const services = createServices(store, { sendEmail: async () => { throw new Error('No provider calls are allowed in commerce tests.'); } });
 let actor: Principal | undefined = administrator;
 const app: Api = new Hono<{ Variables: Variables }>();
 app.use('*', async (c, next) => { if (actor) c.set('principal', actor); await next(); });
 app.use('*', authenticate(services));
 app.get('/posts', c => c.json({ userId: principal(c).userId }));
 app.get('/workspace', c => c.json({ userId: principal(c).userId }));
 app.onError((error, c) => error instanceof ApiError ? c.json({ code: error.code, message: error.message }, error.status as any) : c.json({ code: 'unexpected', message: error.message }, 500));
 registerReaders(app, services); registerCommerce(app, services); registerCommunity(app, services); registerPodcasts(app, services);
 const request = (path: string, method = 'GET', body?: unknown, headers: Record<string,string> = {}) => app.request(path, { method, headers: { ...(method !== 'GET' ? { Origin: 'https://newsletter.example.com' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
 return { store, services, request, as: (p: Principal | undefined) => { actor = p; }, close: async () => { closed = true; await store.close(); } };
}
const product = { name: 'A useful guide', description: 'A digital field guide', price: 19.5, currency: 'USD', type: 'Digital download' };
const show = { title: 'Good & curious <people>', description: 'A weekly look at useful ideas.', author: 'Alex & Morgan', access: 'public' };
const episode = { title: 'Hello <world>', description: 'A first episode & a fresh start.', audioUrl: 'https://media.example.com/episode.mp3?x=1&y=2', mimeType: 'audio/mpeg', byteLength: 1200, durationSeconds: 60, guid: 'preserved-guid-123' };
async function seedPaidOrder(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string,unknown> = {}) { return f.store.insert('tenant-a', 'order', { userId: 'buyer', productId: 'product-one', productName: 'Guide', type: 'Digital download', currency: 'USD', unitAmount: 1950, amountTotal: 1950, status: 'pending', stripeSessionId: 'cs_verified', assetIds: ['private-asset'], ...overrides }, 'order-one'); }
function checkoutEvent(id = 'evt_verified', amount = 1950): Stripe.Event { return { id, object: 'event', type: 'checkout.session.completed', created: Math.floor(Date.now()/1000), data: { object: { id: 'cs_verified', object: 'checkout.session', payment_status: 'paid', amount_total: amount, currency: 'usd', customer: 'cus_verified', payment_intent: 'pi_verified', metadata: { tenantId: 'tenant-a', userId: 'buyer', productId: 'product-one', orderId: 'order-one' } } } } as unknown as Stripe.Event; }

test('product records survive a database restart and validate money/variants', async t => {
 const directory = await mkdtemp(join(tmpdir(), 'commerce-persist-')); t.after(() => rm(directory, { recursive: true, force: true })); const database = join(directory, 'db.sqlite');
 const f = await fixture(t, database); const created = await f.request('/products', 'POST', product); assert.equal(created.status, 201); const saved = await created.json(); await f.close();
 const reopened = await createSqliteStore(database); t.after(() => reopened.close()); assert.equal((await reopened.get('tenant-a', 'product', saved.id))?.data.price, 19.5);
 const g = await fixture(t); assert.equal((await g.request('/products', 'POST', { ...product, price: 1.001 })).status, 422); assert.equal((await g.request('/products', 'POST', { ...product, currency: 'JPY', price: 1.5 })).status, 422); assert.equal((await g.request('/products', 'POST', { ...product, variants: [{ id: 'one', name: 'A', price: 1 }, { id: 'one', name: 'B', price: 2 }] })).status, 422); assert.equal((await g.request('/products', 'POST', { ...product, stripePriceId: 'attacker-price' })).status, 422);
});
test('commerce requires roles, tenant isolation, and configured payment provider', async t => {
 const f = await fixture(t); const created = await (await f.request('/products', 'POST', product)).json(); f.as({ ...administrator, tenantId: 'tenant-b' }); assert.equal((await f.request(`/products/${created.id}`)).status, 404);
 f.as({ ...administrator, role: 'contributor' }); assert.equal((await f.request('/products', 'POST', product)).status, 403);
 assert.equal((await f.request('/commerce/checkout', 'POST', { productId: created.id, amount: 1 }, { 'Idempotency-Key': 'safe-request-123' })).status, 422);
 assert.equal((await f.request('/commerce/checkout', 'POST', { productId: created.id }, { 'Idempotency-Key': 'safe-request-123' })).status, 503); assert.equal((await f.store.list('tenant-a', 'order')).items.length, 0);
 f.as({ ...administrator, apiKeyId: 'key', scopes: ['audience:read'] }); assert.equal((await f.request('/products')).status, 403);
});
test('Stripe uses the raw signed body, verifies amount, and processes events only once', async t => {
 const f = await fixture(t); await seedPaidOrder(f); f.as(undefined);
 const raw = JSON.stringify(checkoutEvent()); assert.equal((await f.request('/webhooks/stripe', 'POST', raw, { 'stripe-signature': 'invalid' })).status, 400);
 const signature = signing.webhooks.generateTestHeaderString({ payload: raw, secret: process.env.STRIPE_WEBHOOK_SECRET! });
 assert.equal((await f.request('/webhooks/stripe', 'POST', `${raw} `, { 'stripe-signature': signature })).status, 400);
 assert.equal((await f.request('/webhooks/stripe', 'POST', raw, { 'stripe-signature': signature })).status, 200);
 assert.equal((await f.store.get('tenant-a', 'order', 'order-one'))?.data.status, 'paid');
 const replay = await f.request('/webhooks/stripe', 'POST', raw, { 'stripe-signature': signature }); assert.equal((await replay.json()).duplicate, true); assert.equal((await f.store.list('tenant-a', 'event', { filters: { type: 'order.paid' } })).items.length, 1);
});
test('a signed event with the wrong amount cannot grant an entitlement', async t => {
 const f = await fixture(t); await seedPaidOrder(f); await assert.rejects(applyStripeEvent(f.services, checkoutEvent('evt_wrong', 1)), (error: any) => error.code === 'amount_mismatch'); assert.equal((await f.store.get('tenant-a', 'order', 'order-one'))?.data.status, 'pending'); assert.equal(await f.store.get('tenant-a', 'stripe_event', 'evt_wrong'), null);
});
test('provider subscription state controls Premium and cancellation revokes access', async t => {
 const f = await fixture(t); await seedPaidOrder(f, { type: 'Membership', status: 'paid' }); await f.store.insert('tenant-a', 'subscriber', { userId: 'buyer', email: 'buyer@example.com', tier: 'Free' }, 'subscriber-one');
 const event = { id: 'evt_sub_active', created: 10, type: 'customer.subscription.updated', data: { object: { id: 'sub_verified', status: 'active', customer: 'cus_verified', metadata: { tenantId: 'tenant-a', userId: 'buyer', productId: 'product-one', orderId: 'order-one' } } } } as unknown as Stripe.Event;
 await applyStripeEvent(f.services, event); assert.equal(await hasPaidEntitlement(f.store, 'tenant-a', 'buyer'), true); assert.equal((await f.store.get('tenant-a', 'subscriber', 'subscriber-one'))?.data.tier, 'Premium');
 await applyStripeEvent(f.services, { ...event, id: 'evt_sub_cancel', created: 11, type: 'customer.subscription.deleted' } as Stripe.Event); assert.equal(await hasPaidEntitlement(f.store, 'tenant-a', 'buyer'), false); assert.equal((await f.store.get('tenant-a', 'subscriber', 'subscriber-one'))?.data.tier, 'Free');
 await applyStripeEvent(f.services, { ...event, id: 'evt_sub_stale', created: 9 } as Stripe.Event); assert.equal(await hasPaidEntitlement(f.store, 'tenant-a', 'buyer'), false);
});
test('digital download grants are owner scoped, short lived, and revoked on refund', async t => {
 const f = await fixture(t); await seedPaidOrder(f, { status: 'paid' }); f.as({ ...administrator, userId: 'stranger', role: 'contributor' }); assert.equal((await f.request('/commerce/orders/order-one/downloads', 'POST')).status, 403);
 f.as({ ...administrator, userId: 'buyer', role: 'contributor' }); const issued = await f.request('/commerce/orders/order-one/downloads', 'POST'); assert.equal(issued.status, 200); const token = (await issued.json()).items[0]; assert.ok(Date.parse(token.expiresAt) - Date.now() <= 600000); const tokenPath = new URL(token.url).pathname.replace(/^\/api/, '');
 const order = await f.store.get('tenant-a', 'order', 'order-one'); await f.store.update('tenant-a', 'order', 'order-one', { ...order!.data, status: 'refunded' }, order!.version); f.as(undefined); assert.equal((await f.request(tokenPath)).status, 403);
});
test('community premium gating and bans are checked against persisted state', async t => {
 const f = await fixture(t); const channel = await (await f.request('/community/channels', 'POST', { name: 'Members', access: 'premium' })).json();
 f.as({ ...administrator, userId: 'reader', role: 'contributor' }); assert.equal((await f.request(`/community/channels/${channel.id}/posts`, 'POST', { body: 'Hello' })).status, 403);
 await f.store.insert('tenant-a', 'subscription', { userId: 'reader', status: 'active' }, 'sub_reader'); assert.equal((await f.request(`/community/channels/${channel.id}/posts`, 'POST', { body: 'Hello' })).status, 201);
 f.as(administrator); assert.equal((await f.request('/community/members/reader/ban', 'POST', { banned: true, reason: 'Moderation test' })).status, 200);
 f.as({ ...administrator, userId: 'reader', role: 'contributor' }); assert.equal((await f.request('/community/channels')).status, 403); assert.equal((await f.request('/community/join', 'POST')).status, 403);
});
test('community ownership, threaded comments, reports, and DMs do not leak across users', async t => {
 const f = await fixture(t); const channel = await (await f.request('/community/channels', 'POST', { name: 'Everyone' })).json();
 f.as({ ...administrator, userId: 'author', role: 'contributor' }); const post = await (await f.request(`/community/channels/${channel.id}/posts`, 'POST', { title: 'A thought', body: 'Content' })).json(); const comment = await (await f.request(`/community/posts/${post.id}/comments`, 'POST', { body: 'First' })).json(); assert.equal((await f.request(`/community/posts/${post.id}/comments`, 'POST', { body: 'Reply', parentId: comment.id })).status, 201);
 f.as({ ...administrator, userId: 'other', role: 'contributor' }); await f.request('/community/join', 'POST'); assert.equal((await f.request(`/community/posts/${post.id}`, 'PUT', { body: 'Hijacked' })).status, 403); const report = await (await f.request('/community/reports', 'POST', { kind: 'post', targetId: post.id, reason: 'Needs review' })).json();
 f.as(administrator); assert.equal((await f.request(`/community/moderation/${report.id}/resolve`, 'POST', { action: 'hide' })).status, 200);
 f.as({ ...administrator, userId: 'other', role: 'contributor' }); assert.equal((await f.request(`/community/posts/${post.id}`)).status, 404); await f.request('/community/messages/author', 'POST', { body: 'Private conversation' });
 f.as({ ...administrator, userId: 'third', role: 'contributor' }); const messages = await (await f.request('/community/messages/author')).json(); assert.equal(messages.items.length, 0);
 f.as({ ...administrator, userId: 'author', role: 'contributor' }); assert.equal((await (await f.request('/community/messages/other')).json()).items[0].body, 'Private conversation');
});
test('podcast RSS escapes content, preserves GUIDs, and public pages exclude drafts', async t => {
 const f = await fixture(t); await f.store.insert('__system__', 'tenant', { tenantId: 'tenant-a', slug: 'good-ideas' }, 'tenant-a'); const podcast = await (await f.request('/podcasts/shows', 'POST', show)).json();
 assert.equal((await f.request(`/podcasts/shows/${podcast.id}/episodes`, 'POST', { ...episode, audioUrl: 'http://127.0.0.1/file.mp3' })).status, 422);
 const createdResponse = await f.request(`/podcasts/shows/${podcast.id}/episodes`, 'POST', episode); assert.equal(createdResponse.status, 201); const created = await createdResponse.json();
 assert.equal((await f.request(`/podcasts/shows/${podcast.id}/episodes`, 'POST', episode)).status, 409);
 const draft = await f.request(`/public/good-ideas/podcasts/${podcast.id}/episodes/${created.id}`); assert.equal(draft.status, 404);
 const published = await f.request(`/podcasts/episodes/${created.id}/publish`, 'POST', {}); assert.equal(published.status, 200, await published.text());
 f.as(undefined); const rss = await (await f.request(`/public/good-ideas/podcasts/${podcast.id}/feed.xml`)).text(); assert.match(rss, /Hello &lt;world&gt;/); assert.match(rss, /preserved-guid-123/); assert.match(rss, /x=1&amp;y=2/); assert.doesNotMatch(rss, /Hello <world>/); assert.equal((await f.request(`/public/good-ideas/podcasts/${podcast.id}/episodes/${created.id}`)).status, 200);
});
test('private podcast feed and audio access stop immediately on subscription cancellation', async t => {
 const f = await fixture(t); const podcast = await (await f.request('/podcasts/shows', 'POST', { ...show, access: 'premium' })).json(); await f.store.insert('tenant-a', 'media', { name: 'episode.mp3', mimeType: 'audio/mpeg', access: 'private', storage: 'blob', pathname: 'tenant-a/episode.mp3' }, 'audio-private');
 const saved = await (await f.request(`/podcasts/shows/${podcast.id}/episodes`, 'POST', { ...episode, audioUrl: undefined, mediaId: 'audio-private' })).json(); assert.equal((await f.request(`/podcasts/episodes/${saved.id}/publish`, 'POST', {})).status, 200);
 f.as({ ...administrator, userId: 'buyer', role: 'contributor' }); assert.equal((await f.request(`/podcasts/shows/${podcast.id}/private-feed`, 'POST')).status, 403); await f.store.insert('tenant-a', 'subscription', { userId: 'buyer', status: 'active' }, 'sub_private'); const issued = await f.request(`/podcasts/shows/${podcast.id}/private-feed`, 'POST'); assert.equal(issued.status, 201); const grant = await issued.json(); const path = new URL(grant.url).pathname.replace(/^\/api/, ''); f.as(undefined);
 const response = await f.request(path); assert.equal(response.status, 200); const rss = await response.text(); assert.match(rss, /\/episodes\/.*\/audio/); assert.doesNotMatch(rss, /media\.example\.com/);
 const subscription = await f.store.get('tenant-a', 'subscription', 'sub_private'); await f.store.update('tenant-a', 'subscription', 'sub_private', { ...subscription!.data, status: 'canceled' }, subscription!.version); assert.equal((await f.request(path)).status, 403); const audioUrl = rss.match(/<enclosure url="([^"]+)"/)![1]; assert.equal((await f.request(new URL(audioUrl).pathname.replace(/^\/api/, ''))).status, 403);
});
test('scheduled podcast publication persists in the durable queue', async t => {
 const f = await fixture(t); const podcast = await (await f.request('/podcasts/shows', 'POST', show)).json(); const created = await (await f.request(`/podcasts/shows/${podcast.id}/episodes`, 'POST', episode)).json(); const scheduledAt = new Date(Date.now() + 3600000).toISOString(); const response = await f.request(`/podcasts/episodes/${created.id}/publish`, 'POST', { scheduledAt }); assert.equal(response.status, 200); assert.equal((await f.store.get('tenant-a', 'podcast_episode', created.id))?.data.status, 'Scheduled'); const jobs = await f.store.list('__jobs__', 'job', { filters: { type: 'podcast.publish' } }); assert.equal(jobs.items.length, 1); assert.equal(jobs.items[0].data.runAt, scheduledAt);
});

test('reader magic links are single-use and reader cookies never grant workspace access', async t => {
 const f = await fixture(t); await f.store.insert('__system__', 'tenant', { tenantId: 'tenant-a', slug: 'readers' }, 'tenant-a'); await f.store.insert('__system__', 'tenant', { tenantId: 'tenant-b', slug: 'other-publication' }, 'tenant-b'); await f.store.insert('tenant-a', 'subscriber', { email: 'reader@example.com', name: 'Reader', status: 'Active', tier: 'Free' }, 'reader-subscriber');
 const channel = await (await f.request('/community/channels', 'POST', { name: 'Everyone' })).json();
 const originalKey = config.resendApiKey, originalFrom = config.emailFrom; config.resendApiKey = 'test_injected_email_only'; config.emailFrom = 'readers@example.com'; t.after(() => { config.resendApiKey = originalKey; config.emailFrom = originalFrom; });
 const messages: any[] = []; f.services.sendEmail = async message => { messages.push(message); return { id: 'test-reader-email' }; }; f.as(undefined);
 const response = await f.request('/public/readers/reader/login', 'POST', { email: 'reader@example.com' }); assert.equal(response.status, 202);
 const unknown = await f.request('/public/readers/reader/login', 'POST', { email: 'unknown@example.com' }); assert.equal(unknown.status, 202); assert.deepEqual(await unknown.json(), await response.json());
 const run = await f.services.runJobs(); assert.equal(run.failed, 0); assert.equal(messages.length, 1);
 const token = messages[0].text.match(/token=([A-Za-z0-9_-]+)/)[1]; const jobs = await f.store.list('__jobs__', 'job'); assert.equal(JSON.stringify(jobs).includes(token), false, 'Raw reader login tokens must not remain in the durable queue');
 const verified = await f.request('/public/readers/reader/verify', 'POST', { token }); assert.equal(verified.status, 200); const cookie = verified.headers.get('set-cookie')!.split(';')[0]; assert.match(verified.headers.get('set-cookie')!, /HttpOnly/i); assert.match(verified.headers.get('set-cookie')!, /Secure/i);
 assert.equal((await f.request('/public/readers/reader/verify', 'POST', { token })).status, 401);
 assert.equal((await f.request('/public/readers/reader/me', 'GET', undefined, { Cookie: cookie })).status, 200);
 assert.equal((await f.request(`/public/readers/community/channels/${channel.id}/posts`, 'POST', { body: 'Cross-site write' }, { Cookie: cookie, Origin: 'https://attacker.example' })).status, 403);
 assert.equal((await f.request('/public/readers/reader/logout', 'POST', undefined, { Cookie: cookie, Origin: '' })).status, 403);
 assert.equal((await f.request('/posts', 'GET', undefined, { Cookie: cookie })).status, 401); assert.equal((await f.request('/workspace', 'GET', undefined, { Cookie: cookie })).status, 401); assert.equal((await f.request('/products', 'GET', undefined, { Cookie: cookie })).status, 401);
 assert.equal((await f.request('/public/other-publication/reader/me', 'GET', undefined, { Cookie: cookie })).status, 401);
 assert.equal((await f.request(`/public/readers/community/channels/${channel.id}/posts`, 'POST', { body: 'A real reader post' }, { Cookie: cookie })).status, 201);
 const posts = await (await f.request(`/public/readers/community/channels/${channel.id}/posts`, 'GET', undefined, { Cookie: cookie })).json(); assert.equal(posts.items[0].authorId, 'reader:reader-subscriber');
 assert.equal((await f.request('/public/readers/checkout', 'POST', { productId: 'missing' }, { Cookie: cookie, 'Idempotency-Key': 'reader-checkout-123' })).status, 503, 'Authenticated reader reaches provider configuration check');
 const sub = await f.store.get('tenant-a', 'subscriber', 'reader-subscriber'); await f.store.update('tenant-a', 'subscriber', sub!.id, { ...sub!.data, status: 'Unsubscribed' }, sub!.version); assert.equal((await f.request('/public/readers/reader/me', 'GET', undefined, { Cookie: cookie })).status, 401);
});

test('paid digital products automatically deliver expiring links that stream actual private bytes', async t => {
 const f = await fixture(t); const bytes = new TextEncoder().encode('%PDF-1.4\nA purchased digital guide'); const media = await saveMedia(f.services, 'tenant-a', 'admin', bytes, 'guide.pdf', 'application/pdf'); t.after(() => rm(join(process.cwd(), '.data', 'media', media.data.pathname), { force: true }));
 await seedPaidOrder(f, { assetIds: [media.id], buyerEmail: 'buyer@example.com' }); const originalFrom = config.emailFrom; config.emailFrom = 'delivery@example.com'; t.after(() => { config.emailFrom = originalFrom; });
 const messages: any[] = []; f.services.sendEmail = async message => { messages.push(message); return { id: 'injected-digital-delivery' }; }; await applyStripeEvent(f.services, checkoutEvent('evt_digital')); const result = await f.services.runJobs(); assert.equal(result.failed, 0); assert.equal(messages.length, 1); assert.match(messages[0].text, /10 minutes/); assert.ok((await f.store.get('tenant-a', 'order', 'order-one'))?.data.deliverySentAt);
 const url = messages[0].text.match(/https:\/\/[^\s]+\/api\/commerce\/downloads\/[^\s]+/)[0]; f.as(undefined); const response = await f.request(new URL(url).pathname.replace(/^\/api/, '')); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/pdf'); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes); assert.match(response.headers.get('content-disposition')!, /attachment/);
 const grantId = hash(new URL(url).pathname.split('/').at(-1)!); const grant = await f.store.get('tenant-a', 'download_token', grantId); await f.store.update('tenant-a', 'download_token', grantId, { ...grant!.data, expiresAt: '2000-01-01T00:00:00Z' }, grant!.version); assert.equal((await f.request(new URL(url).pathname.replace(/^\/api/, ''))).status, 410);
});
