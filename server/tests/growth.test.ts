import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { Api, Principal, Variables } from '../contracts.js';
import { ApiError, hash } from '../core/http.js';
import { config } from '../core/config.js';
import { createSqliteStore } from '../core/store.js';
import { createServices } from '../core/services.js';
import { classifyWebsiteAgent, confirmGrowthSignup, growthSignupFields, recordGrowthSignup, recordWebsiteRequest, registerGrowth } from '../modules/growth.js';
import { registerAudience } from '../modules/audience.js';

const admin: Principal = { userId: 'owner', tenantId: 'publication-a', role: 'admin' };
async function fixture() {
  const store = await createSqliteStore(':memory:'), services = createServices(store, { sendEmail: async () => ({ id: randomUUID() }) });
  const app: Api = new Hono<{ Variables: Variables }>(); let actor: Principal | undefined = admin;
  app.use('*', async (c, next) => { if (actor) c.set('principal', actor); await next(); });
  app.onError((error, c) => error instanceof ApiError ? c.json({ code: error.code, message: error.message }, error.status as 400) : c.json({ code: 'unexpected', message: String(error) }, 500));
  registerGrowth(app, services); registerAudience(app, services);
  await store.insert('__system__', 'tenant', { tenantId: admin.tenantId, slug: 'daily-note' }, admin.tenantId);
  await store.insert(admin.tenantId, 'publication', { slug: 'daily-note', name: 'Daily Note', domain: 'newsletter.example.com', doubleOptIn: false }, 'publication');
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => app.request(path, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const create = async (path: string, body: unknown) => { const response = await request('POST', path, body); assert.equal(response.status, 201, await response.clone().text()); return response.json() as Promise<any>; };
  const subscriber = (status = 'Active') => store.insert(admin.tenantId, 'subscriber', { email: `${randomUUID()}@example.com`, name: 'Reader', status, tier: 'Free', source: 'Website', tags: [], customFields: {} });
  return { store, services, app, request, create, subscriber, setActor: (value: Principal | undefined) => { actor = value; } };
}

test('growth routes enforce membership roles, key scopes, and publication boundaries', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const list = await f.create('/newsletter-lists', { name: 'Weekly edition' });
  f.setActor(undefined); assert.equal((await f.request('GET', '/newsletter-lists')).status, 401);
  f.setActor({ ...admin, role: 'contributor' }); assert.equal((await f.request('POST', '/newsletter-lists', { name: 'Forbidden' })).status, 403);
  f.setActor({ ...admin, apiKeyId: 'read-only', scopes: ['growth:read'] }); assert.equal((await f.request('POST', '/newsletter-lists', { name: 'Forbidden' })).status, 403);
  f.setActor({ ...admin, tenantId: 'publication-b' }); assert.equal((await f.request('GET', `/newsletter-lists/${list.id}`)).status, 404);
  assert.deepEqual((await (await f.request('GET', '/newsletter-lists')).json() as any).items, []);
});

test('name-only PATCH requests preserve list, form, recommendation and milestone configuration', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const privateList = await f.create('/newsletter-lists', { name: 'Staff list', description: 'Keep this description', public: false, active: false });
  const listResponse = await f.request('PATCH', `/newsletter-lists/${privateList.id}`, { name: 'Renamed staff list' });
  const list = await listResponse.json() as any; assert.equal(list.public, false); assert.equal(list.active, false); assert.equal(list.description, privateList.description);
  const publicList = await f.create('/newsletter-lists', { name: 'Public list' });
  const original = await f.create('/signup-forms', { name: 'Original', title: 'Custom title', description: 'Keep text', buttonText: 'Join us', successMessage: 'Thank you', successRedirect: 'https://example.com/thanks', layout: 'full', colors: { background: '#aaaaaa', text: '#111111', button: '#337755' }, font: 'Georgia', listIds: [publicList.id], allowedOrigins: ['https://example.com'] });
  const formResponse = await f.request('PATCH', `/signup-forms/${original.id}`, { name: 'Renamed' });
  const form = await formResponse.json() as any; assert.deepEqual(form.draft, { ...original.draft, name: 'Renamed' });
  const colorResponse = await f.request('PATCH', `/signup-forms/${original.id}`, { colors: { background: '#bbbbbb' } });
  assert.deepEqual((await colorResponse.json() as any).draft.colors, { ...original.draft.colors, background: '#bbbbbb' });
  const recommendation = await f.create('/recommendations', { name: 'Partner', description: 'Retained partnership', url: 'https://example.com/newsletter', active: false });
  const recommended = await (await f.request('PATCH', `/recommendations/${recommendation.id}`, { name: 'Renamed partner' })).json() as any;
  assert.equal(recommended.description, recommendation.description); assert.equal(recommended.active, false); assert.equal(recommended.url, recommendation.url);
  const milestone = await f.create('/referral-milestones', { name: 'Reward', description: 'Retained reward', threshold: 7, active: false });
  const updated = await (await f.request('PATCH', `/referral-milestones/${milestone.id}`, { name: 'Renamed reward' })).json() as any;
  assert.equal(updated.threshold, 7); assert.equal(updated.active, false); assert.equal(updated.description, milestone.description);
});

test('newsletter memberships are idempotent and require active subscribers; archiving preserves history', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const list = await f.create('/newsletter-lists', { name: 'Weekly edition' }), reader = await f.subscriber();
  const first = await f.create(`/newsletter-lists/${list.id}/members`, { subscriberId: reader.id });
  const second = await f.create(`/newsletter-lists/${list.id}/members`, { subscriberId: reader.id });
  assert.equal(first.id, second.id);
  assert.equal((await f.store.list(admin.tenantId, 'newsletter_membership')).items.length, 1);
  const pending = await f.subscriber('Pending'); assert.equal((await f.request('POST', `/newsletter-lists/${list.id}/members`, { subscriberId: pending.id })).status, 409);
  assert.equal((await f.request('DELETE', `/newsletter-lists/${list.id}/members/${reader.id}`)).status, 204);
  assert.equal((await f.store.get(admin.tenantId, 'newsletter_membership', first.id))?.data.status, 'unsubscribed');
  assert.equal((await f.request('DELETE', `/newsletter-lists/${list.id}`)).status, 204);
  assert.equal((await f.store.get(admin.tenantId, 'newsletter_list', list.id))?.data.active, false);
  assert.equal((await f.store.list(admin.tenantId, 'newsletter_membership')).items.length, 1);
});

test('signup forms publish a stable live snapshot and render escaped controls with protected signup submission', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const list = await f.create('/newsletter-lists', { name: 'Design weekly' });
  const form = await f.create('/signup-forms', { name: 'Footer', title: '<script>alert(1)</script>', listIds: [list.id], colors: { background: '#ffffff', text: '#17252a', button: '#ef6b4a' } });
  assert.equal((await f.request('GET', `/public/daily-note/forms/${form.id}`)).status, 404);
  assert.equal((await f.request('POST', `/signup-forms/${form.id}/publish`, {})).status, 200);
  assert.equal((await f.request('PATCH', `/signup-forms/${form.id}`, { title: 'Unpublished title' })).status, 200);
  const response = await f.request('GET', `/public/daily-note/forms/${form.id}?utm_source=partner&utm_medium=email`);
  assert.equal(response.status, 200); const html = await response.text();
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('Unpublished title'));
  assert.ok(html.includes('/api/public/daily-note/subscribe'));
  assert.ok(html.includes('name="website"')); assert.ok(html.includes('name="consent"')); assert.ok(html.includes('name="utm_source" value="partner"'));
  assert.ok(response.headers.get('Content-Security-Policy')?.includes("script-src 'nonce-"));
  assert.deepEqual(growthSignupFields.listIds.parse(['', list.id]), [list.id]);
  assert.equal((await f.request('POST', '/signup-forms', { name: 'Unsafe', title: 'Form', successRedirect: 'javascript:alert(1)' })).status, 422);
});

test('signup attribution keeps pending memberships and awards referral milestones only after activation', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const list = await f.create('/newsletter-lists', { name: 'Weekly' }), referrer = await f.subscriber(), reader = await f.subscriber('Pending');
  const link = await f.create('/referral-links', { subscriberId: referrer.id });
  const milestone = await f.create('/referral-milestones', { name: 'First referral', threshold: 1 });
  await f.store.transaction(tx => recordGrowthSignup(f.services, tx, admin.tenantId, reader, { listIds: [list.id], referralCode: link.referralCode, utm: { source: 'newsletter', medium: 'email' } }));
  const memberId = hash(`${list.id}:${reader.id}`);
  assert.equal((await f.store.get(admin.tenantId, 'newsletter_membership', memberId))?.data.status, 'pending');
  assert.equal((await f.store.list(admin.tenantId, 'referral_credit')).items.length, 0);
  const active = await f.store.update(admin.tenantId, 'subscriber', reader.id, { ...reader.data, status: 'Active' });
  await f.store.transaction(async tx => { await confirmGrowthSignup(f.services, tx, admin.tenantId, active); await confirmGrowthSignup(f.services, tx, admin.tenantId, active); });
  assert.equal((await f.store.get(admin.tenantId, 'newsletter_membership', memberId))?.data.status, 'subscribed');
  assert.equal((await f.store.get(admin.tenantId, 'referral_progress', referrer.id))?.data.confirmedCount, 1);
  const rewards = await f.store.list(admin.tenantId, 'referral_reward'); assert.equal(rewards.items.length, 1); assert.equal(rewards.items[0].data.milestoneId, milestone.id); assert.equal(rewards.items[0].data.status, 'earned');
  assert.equal((await f.request('POST', `/referral-rewards/${rewards.items[0].id}/fulfill`, {})).status, 200);
  assert.equal((await f.store.get(admin.tenantId, 'referral_reward', rewards.items[0].id))?.data.status, 'fulfilled');
});

test('self referrals, disabled links and foreign/private list injection cannot earn rewards or leak memberships', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const referrer = await f.subscriber(), link = await f.create('/referral-links', { subscriberId: referrer.id });
  await f.store.transaction(tx => recordGrowthSignup(f.services, tx, admin.tenantId, referrer, { referralCode: link.referralCode }));
  assert.equal((await f.store.list(admin.tenantId, 'referral_credit')).items.length, 0);
  const pending = await f.subscriber('Pending');
  await f.store.transaction(tx => recordGrowthSignup(f.services, tx, admin.tenantId, pending, { referralCode: link.referralCode }));
  await f.request('DELETE', `/referral-links/${link.id}`);
  const active = await f.store.update(admin.tenantId, 'subscriber', pending.id, { ...pending.data, status: 'Active' });
  await f.store.transaction(tx => confirmGrowthSignup(f.services, tx, admin.tenantId, active));
  assert.equal((await f.store.list(admin.tenantId, 'referral_credit')).items.length, 0);
  const privateList = await f.create('/newsletter-lists', { name: 'Staff only', public: false });
  const reader = await f.subscriber();
  await assert.rejects(f.store.transaction(tx => recordGrowthSignup(f.services, tx, admin.tenantId, reader, { listIds: [privateList.id] })), (error: unknown) => error instanceof ApiError && error.code === 'list_unavailable');
  await assert.rejects(f.store.transaction(tx => recordGrowthSignup(f.services, tx, 'other-tenant', reader, { listIds: [privateList.id] })), (error: unknown) => error instanceof ApiError && error.status === 404);
  assert.equal(await f.store.get(admin.tenantId, 'signup_attribution', reader.id), null);
});

test('public pageviews validate origin, deduplicate events, minimize data and report actual filtered counts', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const origin = new URL(config.appUrl).origin;
  const input = { eventId: randomUUID(), path: '/stories?email=private@example.com#secret', referrer: 'https://partner.example/path?secret=abc', utm: { source: 'partner', medium: 'email' } };
  assert.equal((await f.request('POST', '/public/daily-note/pageviews', input)).status, 403);
  assert.equal((await f.request('POST', '/public/daily-note/pageviews', input, { origin: 'https://attacker.example' })).status, 403);
  const headers = { origin, 'user-agent': 'Mozilla/5.0 iPhone Mobile Safari' };
  assert.equal((await f.request('POST', '/public/daily-note/pageviews', input, headers)).status, 202);
  assert.equal((await f.request('POST', '/public/daily-note/pageviews', input, headers)).status, 202);
  assert.equal((await f.request('POST', '/public/daily-note/pageviews', { eventId: randomUUID(), path: '/stories' }, { origin, 'user-agent': 'Googlebot/2.1' })).status, 202);
  const events = await f.store.list(admin.tenantId, 'website_event'); assert.equal(events.items.length, 2);
  const serialized = JSON.stringify(events.items); assert.ok(!serialized.includes('private@example.com')); assert.ok(!serialized.includes('secret=abc')); assert.ok(!serialized.includes('Mozilla')); assert.ok(!serialized.includes('ipHash')); assert.ok(!serialized.includes('user-agent'));
  const report = await (await f.request('GET', '/analytics/website')).json() as any;
  assert.equal(report.views, 2); assert.equal(report.likelyBotViews, 1); assert.equal(report.unidentifiedAsBotViews, 1); assert.equal(report.uniqueVisitors, null); assert.equal(report.byPath['/stories'], 2);
  const mobile = await (await f.request('GET', '/analytics/website?device=mobile&channel=email')).json() as any;
  assert.equal(mobile.views, 1); assert.equal(mobile.likelyBotViews, 0);
  assert.equal((await f.request('GET', '/analytics/website?from=2020-01-01&to=2026-01-01')).status, 422);
});

test('server page requests and client page views stay in separate report series', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  await recordWebsiteRequest(f.services, admin.tenantId, { path: '/news?token=secret', referrer: 'https://example.com/private?token=x', userAgent: 'Mozilla/5.0' });
  await recordWebsiteRequest(f.services, admin.tenantId, { path: '/news', userAgent: 'GPTBot' });
  const client = await (await f.request('GET', '/analytics/website')).json() as any;
  const server = await (await f.request('GET', '/analytics/website?source=page_request')).json() as any;
  assert.equal(client.views, 0); assert.equal(server.views, 2); assert.equal(server.likelyBotViews, 1);
  assert.equal(classifyWebsiteAgent('').botClassification, 'unknown');
});

test('recommendations are publication-managed entries with no fabricated network or earnings metrics', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const recommendation = await f.create('/recommendations', { name: 'Another newsletter', url: 'https://example.com/newsletter' });
  await f.create('/recommendations', { name: 'Inactive', url: 'https://example.com/hidden', active: false });
  const publicFeed = await (await f.request('GET', '/public/daily-note/recommendations')).json() as any;
  assert.equal(publicFeed.items.length, 1); assert.equal(publicFeed.items[0].id, recommendation.id); assert.equal(publicFeed.network, 'publication_managed');
  assert.equal((await f.request('POST', '/recommendations', { name: 'Invalid', url: 'javascript:alert(1)' })).status, 422);
  await f.request('DELETE', `/recommendations/${recommendation.id}`);
  assert.equal((await (await f.request('GET', '/public/daily-note/recommendations')).json() as any).items.length, 0);
});

test('public signup records form, UTM, list and referral attribution through the existing subscribe endpoint', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const list = await f.create('/newsletter-lists', { name: 'A public list' }), referrer = await f.subscriber();
  const link = await f.create('/referral-links', { subscriberId: referrer.id });
  const form = await f.create('/signup-forms', { name: 'Embed', title: 'Subscribe', listIds: [list.id] });
  await f.request('POST', `/signup-forms/${form.id}/publish`, {});
  const email = 'new-reader@example.com';
  const response = await f.request('POST', '/public/daily-note/subscribe', { email, consent: true, formId: form.id, listIds: [list.id], referralCode: link.referralCode, utm: { source: 'partner', medium: 'email' } });
  assert.equal(response.status, 202, await response.clone().text());
  const subscriber = (await f.store.list(admin.tenantId, 'subscriber', { filters: { email }, limit: 1 })).items[0]; assert.ok(subscriber);
  const attribution = await f.store.get(admin.tenantId, 'signup_attribution', subscriber.id);
  assert.equal(attribution?.data.formId, form.id); assert.equal(attribution?.data.utm.source, 'partner'); assert.equal(attribution?.data.status, 'confirmed');
  assert.equal((await f.store.get(admin.tenantId, 'newsletter_membership', hash(`${list.id}:${subscriber.id}`)))?.data.status, 'subscribed');
  assert.equal((await f.store.get(admin.tenantId, 'referral_progress', referrer.id))?.data.confirmedCount, 1);
  const formBody = new URLSearchParams({ email: 'form-reader@example.com', name: 'Form reader', consent: 'true', source: `form:${form.id}`, formId: form.id, startedAt: String(Date.now() - 2000), utm_source: 'embedded-site', website: '' });
  formBody.append('listIds', ''); formBody.append('listIds', list.id);
  const formResponse = await f.app.request('/public/daily-note/subscribe', { method: 'POST', body: formBody });
  assert.equal(formResponse.status, 202, await formResponse.clone().text());
  const formReader = (await f.store.list(admin.tenantId, 'subscriber', { filters: { email: 'form-reader@example.com' }, limit: 1 })).items[0];
  assert.deepEqual((await f.store.get(admin.tenantId, 'signup_attribution', formReader.id))?.data.listIds, [list.id]);
  assert.equal((await f.store.get(admin.tenantId, 'signup_attribution', formReader.id))?.data.utm.source, 'embedded-site');
});
