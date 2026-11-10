import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { EmailMessage } from '../contracts.js';
import { createSqliteStore } from '../core/store.js';
import { createServices } from '../core/services.js';
import { config } from '../core/config.js';
import { hash, randomToken } from '../core/http.js';
import { escapeHtml, renderPublicPage, safeHref } from '../core/pages.js';
import { createApp } from '../app.js';
import { bootstrapAdmin } from '../modules/auth.js';
import { createUnsubscribeLink } from '../modules/delivery.js';

const browser = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const origin = () => new URL(config.appUrl).origin;

async function fixture(t: TestContext) {
  const store = await createSqliteStore(); t.after(() => store.close());
  const previous = { resendApiKey: config.resendApiKey, emailFrom: config.emailFrom };
  config.resendApiKey = 'test-only-transport'; config.emailFrom = 'Field Notes <hello@example.com>';
  t.after(() => Object.assign(config, previous));
  const sent: EmailMessage[] = [];
  const services = createServices(store, { sendEmail: async message => { sent.push(message); return { id: `test-delivery-${sent.length}` }; } });
  const app = createApp(services);
  const owner = await bootstrapAdmin(store, { email: 'pages-owner@example.com', password: 'test-password-123456', name: 'Page Owner', publicationName: 'Field <Notes>' });
  const tenantId = owner.tenantId; const slug = String((await store.get('__system__', 'tenant', tenantId))!.data.slug);
  const subscriber = (email: string, extra: Record<string, unknown> = {}) => store.insert(tenantId, 'subscriber', { name: 'Reader', email, status: 'Active', tier: 'Free', source: 'Test', tags: [], customFields: {}, joined: '2026-11-01', ...extra });
  const form = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) => app.request(url, { method: 'POST', headers: { ...browser, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });
  return { store, services, app, sent, tenantId, slug, subscriber, form };
}

test('page helper escapes content, rejects unsafe links and keeps strict defaults', () => {
  assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(safeHref('javascript:alert(1)'), null); assert.equal(safeHref('//evil.example/path'), null); assert.equal(safeHref('/api/public/notes'), '/api/public/notes'); assert.equal(safeHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  const html = renderPublicPage({ title: 'T', heading: '<script>alert(1)</script>', message: '"quoted"', accent: 'red;}</style><script>', links: [{ label: 'Bad', href: 'javascript:alert(1)' }], forms: [{ button: 'Go', fields: { token: '"><script>' } }] });
  assert.doesNotMatch(html, /<script>/); assert.match(html, /--accent:#ec73a4/); assert.doesNotMatch(html, /javascript:/); assert.match(html, /<meta name="robots" content="noindex">/);
});

test('double opt-in link shows a confirmation page, confirms only on the reader’s POST and renders HTML results', async t => {
  const f = await fixture(t);
  const signup = await f.app.request(`/api/public/${f.slug}/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'confirm-me@example.com', consent: true }) });
  assert.equal(signup.status, 202); assert.equal(f.sent.length, 1);
  const link = new URL(f.sent[0].text!.match(/https?:\/\/\S+/)![0]); const token = link.searchParams.get('token')!;
  const subscriber = (await f.store.list(f.tenantId, 'subscriber', { filters: { email: 'confirm-me@example.com' } })).items[0];
  const landing = await f.app.request(link.pathname + link.search, { headers: browser });
  assert.equal(landing.status, 200); assert.match(landing.headers.get('content-type')!, /text\/html/); assert.match(landing.headers.get('content-security-policy')!, /form-action 'self'/); assert.equal(landing.headers.get('referrer-policy'), 'no-referrer');
  const page = await landing.text(); assert.match(page, /Confirm subscription/); assert.match(page, /Field &lt;Notes&gt;/); assert.match(page, new RegExp(`name="token" value="${token}"`));
  assert.equal((await f.store.get(f.tenantId, 'subscriber', subscriber.id))!.data.status, 'Pending', 'Viewing the link must not confirm (mail scanners prefetch links)');
  const confirmed = await f.form(link.pathname + link.search, { token });
  assert.equal(confirmed.status, 200); assert.match(await confirmed.text(), /You’re subscribed/);
  assert.equal((await f.store.get(f.tenantId, 'subscriber', subscriber.id))!.data.status, 'Active');
  const reused = await f.form(link.pathname, { token }); assert.equal(reused.status, 400); assert.match(await reused.text(), /invalid or has expired/);
  const stale = await f.app.request(link.pathname + link.search, { headers: browser }); assert.equal(stale.status, 400); assert.match(await stale.text(), /invalid or has expired/);
  const malformed = await f.app.request(`/api/public/${f.slug}/confirm?token=short`, { headers: browser }); assert.equal(malformed.status, 400); assert.match(malformed.headers.get('content-type')!, /text\/html/);
  const unknown = await f.app.request(`/api/public/not-a-publication/confirm?token=${token}`, { headers: browser }); assert.equal(unknown.status, 404); assert.match(await unknown.text(), /Publication not found/);
});

test('JSON clients keep the JSON confirmation contract', async t => {
  const f = await fixture(t);
  await f.app.request(`/api/public/${f.slug}/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'json-client@example.com', consent: true }) });
  const token = new URL(f.sent[0].text!.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
  const response = await f.app.request(`/api/public/${f.slug}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { message: 'Your subscription is confirmed.' });
  const again = await f.app.request(`/api/public/${f.slug}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(again.status, 400); assert.equal((await again.json()).error.code, 'invalid_confirmation');
});

test('unsubscribe pages name the publication, browsers get HTML results and one-click clients keep JSON', async t => {
  const f = await fixture(t); const reader = await f.subscriber('leaving@example.com'); const url = await createUnsubscribeLink(f.store, f.tenantId, reader.id);
  const landing = await f.app.request(url, { headers: browser }); assert.equal(landing.status, 200); const page = await landing.text();
  assert.match(page, /Unsubscribe from this newsletter\?/); assert.match(page, /Field &lt;Notes&gt;/); assert.match(page, /<form method="post">/);
  assert.equal((await f.store.get(f.tenantId, 'subscriber', reader.id))!.data.status, 'Active');
  const done = await f.form(url, {}); assert.equal(done.status, 200); assert.match(await done.text(), /You’re unsubscribed/);
  assert.equal((await f.store.get(f.tenantId, 'subscriber', reader.id))!.data.status, 'Unsubscribed');
  const oneClick = await f.app.request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(oneClick.status, 200); assert.deepEqual(await oneClick.json(), { unsubscribed: true });
  const tampered = await f.app.request(url.replace(/\.[^.]+$/, '.forged-signature'), { headers: browser });
  assert.equal(tampered.status, 400); assert.match(tampered.headers.get('content-type')!, /text\/html/); assert.match(await tampered.text(), /This unsubscribe link is invalid/);
  const apiTampered = await f.app.request(url.replace(/\.[^.]+$/, '.forged-signature'), { method: 'POST' });
  assert.equal(apiTampered.status, 400); assert.equal((await apiTampered.json()).error.code, 'unsubscribe_invalid');
});

test('reader sign-in links survive link scanners: GET shows a button and only the same-origin POST signs in', async t => {
  const f = await fixture(t); const reader = await f.subscriber('reader@example.com', { name: 'Riley Reader' });
  const token = randomToken(); await f.store.insert(f.tenantId, 'reader_magic_token', { subscriberId: reader.id, expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), usedAt: null }, hash(token));
  const path = `/api/public/${f.slug}/reader/verify?token=${token}`;
  const landing = await f.app.request(path, { headers: browser });
  assert.equal(landing.status, 200); assert.equal(landing.headers.get('referrer-policy'), 'strict-origin', 'no-referrer would make browsers send Origin: null on the form post');
  assert.match(await landing.text(), /name="token"/); assert.equal(landing.headers.get('set-cookie'), null);
  assert.equal((await f.store.get(f.tenantId, 'reader_magic_token', hash(token)))!.data.usedAt, null, 'Viewing the link must not spend the token');
  const crossSite = await f.form(path, { token }, { origin: 'https://attacker.example' }); assert.equal(crossSite.status, 403); assert.match(crossSite.headers.get('content-type')!, /text\/html/);
  const signedIn = await f.form(path, { token }, { origin: origin() });
  assert.equal(signedIn.status, 303); assert.equal(signedIn.headers.get('location'), `${config.appUrl}/api/public/${f.slug}?reader=signed-in`);
  const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]; assert.match(cookie, /^bh_reader=/);
  const home = await f.app.request(`/api/public/${f.slug}?reader=signed-in`, { headers: { ...browser, cookie } });
  assert.equal(home.status, 200); const html = await home.text(); assert.match(html, /Signed in as <strong>reader@example.com<\/strong>/); assert.match(html, /You’re signed in/);
  const reused = await f.form(path, { token }, { origin: origin() }); assert.equal(reused.status, 401); assert.match(await reused.text(), /invalid or expired/);
  const signedOut = await f.form(`/api/public/${f.slug}/reader/logout`, {}, { origin: origin(), cookie });
  assert.equal(signedOut.status, 303); assert.equal(signedOut.headers.get('location'), `${config.appUrl}/api/public/${f.slug}?reader=signed-out`);
  assert.equal((await f.app.request(`/api/public/${f.slug}/reader/me`, { headers: { cookie } })).status, 401);
});

test('public publication home lists only published posts, newest first, escaped and paginated', async t => {
  const f = await fixture(t);
  await f.store.insert(f.tenantId, 'post', { title: 'Hidden draft', subtitle: '', content: '<p>x</p>', status: 'Draft', date: '2026-11-01T00:00:00.000Z', audience: 'All subscribers' });
  // The archive is ordered by record creation; distinct timestamps keep the expected order deterministic.
  for (let index = 0; index < 22; index++) { await new Promise(resolve => setTimeout(resolve, 3)); await f.store.insert(f.tenantId, 'post', { title: index === 21 ? 'Newest <issue>' : `Issue ${index}`, subtitle: index === 21 ? 'Fresh & useful' : '', content: '<p>x</p>', status: 'Published', date: `2026-10-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`, audience: index === 21 ? 'Premium subscribers' : 'All subscribers' }); }
  const response = await f.app.request(`/api/public/${f.slug}`, { headers: browser });
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-robots-tag'), null); assert.match(response.headers.get('cache-control')!, /private/);
  const html = await response.text();
  assert.doesNotMatch(html, /Hidden draft/); assert.match(html, /Newest &lt;issue&gt;/); assert.match(html, /Fresh &amp; useful/); assert.match(html, /Premium/);
  assert.ok(html.indexOf('Newest &lt;issue&gt;') < html.indexOf('Issue 20'), 'Newest posts come first');
  assert.equal((html.match(/<li>/g) || []).length, 20);
  const older = html.match(/href="([^"]+cursor=[^"]+)"/)![1].replaceAll('&amp;', '&');
  const second = await (await f.app.request(older, { headers: browser })).text(); assert.match(second, /Issue 0/); assert.match(second, /Issue 1</); assert.doesNotMatch(second, /Newest/);
  assert.ok((await f.store.list(f.tenantId, 'website_event')).items.length >= 2, 'Visits are recorded as first-party page requests');
  const missing = await f.app.request('/api/public/no-such-publication', { headers: browser }); assert.equal(missing.status, 404); assert.match(await missing.text(), /isn’t available/);
});

test('rate-limited responses tell browsers and API clients when to retry', async t => {
  const f = await fixture(t);
  // A fixed clock one second into a window keeps the shared 20-per-minute bucket from rolling over mid-test.
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 10, 12, 0, 1) });
  const path = `/api/public/${f.slug}/confirm?token=${'x'.repeat(43)}`;
  let page: Response | undefined;
  for (let attempt = 0; attempt < 21; attempt++) page = await f.app.request(path, { headers: browser });
  assert.equal(page!.status, 429); assert.equal(page!.headers.get('retry-after'), '59'); assert.match(page!.headers.get('content-type')!, /text\/html/); assert.match(await page!.text(), /Please try again shortly/);
  const api = await f.app.request(`/api/public/${f.slug}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'y'.repeat(43) }) });
  assert.equal(api.status, 429); assert.equal(api.headers.get('retry-after'), '59');
  const body = await api.json(); assert.equal(body.error.code, 'rate_limit_exceeded'); assert.equal(body.error.details.retryAfter, 59);
});
