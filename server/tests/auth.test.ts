import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { Api, EmailMessage, Services, Store, Variables } from '../contracts.js';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'auth-tests-use-an-injected-session-secret-with-more-than-32-characters';
process.env.APP_URL = 'http://localhost:5173';
process.env.EMAIL_FROM = 'Workspace <workspace@example.com>';
process.env.RESEND_API_KEY = 'test-transport-is-injected-no-network';
const { createSqliteStore } = await import('../core/store.js');
const { ApiError, hash, id, principal, requireRole, requireScope } = await import('../core/http.js');
const { config } = await import('../core/config.js');
const { authenticate, bootstrapAdmin, membershipId, registerAuth } = await import('../modules/auth.js');

const PASSWORD = 'correct horse newsletter battery';
const ADMIN = { email: 'admin@example.com', password: PASSWORD, name: 'Admin Reader', publicationName: 'The Test Publication' };

async function fixture(t: TestContext) {
  const store = await createSqliteStore(':memory:');
  t.after(() => store.close());
  const messages: EmailMessage[] = [];
  const services: Services = {
    store,
    enqueue: async (job, tx = store) => tx.insert(job.tenantId, 'job', job),
    emit: async () => {},
    registerJob: () => {},
    sendEmail: async message => { messages.push(message); return { id: `test-message-${messages.length}` }; },
  };
  const app: Api = new Hono<{ Variables: Variables }>();
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    throw error;
  });
  app.use('*', authenticate(services));
  registerAuth(app, services);
  app.get('/protected-posts', c => { requireScope(c, 'posts:read'); return c.json({ tenantId: principal(c).tenantId }); });
  app.post('/admin-only', c => { requireScope(c, 'workspace:write'); requireRole(c, 'admin'); return c.json({ ok: true }); });
  const request = (path: string, options: { method?: string; body?: unknown; cookie?: string; key?: string; ip?: string } = {}) => app.request(`http://localhost${path}`, {
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
    headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.key ? { authorization: `Bearer ${options.key}` } : {}), 'x-vercel-forwarded-for': options.ip || '203.0.113.9' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const login = async (email = ADMIN.email, password = PASSWORD) => {
    const response = await request('/auth/login', { body: { email, password } });
    assert.equal(response.status, 200, await response.clone().text());
    return { response, cookie: response.headers.get('set-cookie')!.split(';')[0], body: await response.json() };
  };
  return { store, services, messages, app, request, login };
}

async function addPublication(store: Store, ownerId: string, role: 'admin' | 'member' | 'contributor' = 'member') {
  const tenantId = id();
  await store.insert('__system__', 'tenant', { name: 'Second publication', slug: `second-${tenantId}`, ownerId }, tenantId);
  await store.insert(tenantId, 'publication', { name: 'Second publication' }, tenantId);
  await store.insert('__system__', 'membership', { userId: ownerId, tenantId, role, email: ADMIN.email, name: ADMIN.name }, membershipId(ownerId, tenantId));
  return tenantId;
}

function tokenFrom(message: EmailMessage, name: 'magic_token' | 'invitation_token') {
  const link = /https?:\/\/[^\s]+/.exec(message.text || '')?.[0];
  assert.ok(link);
  const token = new URL(link).searchParams.get(name);
  assert.ok(token);
  return token;
}

test('bootstrap is atomic, normalizes email, hashes passwords, and cannot create duplicate accounts', async t => {
  const f = await fixture(t);
  const result = await bootstrapAdmin(f.store, { ...ADMIN, email: '  ADMIN@example.com  ' });
  const user = await f.store.get('__system__', 'user', result.userId);
  assert.equal(user?.data.email, ADMIN.email);
  assert.match(user?.data.passwordHash, /^scrypt\$32768\$8\$1\$/);
  assert.ok(!JSON.stringify(user).includes(PASSWORD));
  assert.ok(await f.store.get(result.tenantId, 'publication', result.publicationId));
  assert.equal((await f.store.get('__system__', 'membership', membershipId(result.userId, result.tenantId)))?.data.role, 'admin');
  await assert.rejects(bootstrapAdmin(f.store, ADMIN), (error: unknown) => error instanceof ApiError && error.status === 409);
  assert.equal((await f.store.list('__system__', 'tenant')).items.length, 1);
  assert.equal((await f.request('/auth/bootstrap', { body: ADMIN })).status, 404);
});

test('login uses opaque HttpOnly cookies, stores only hashed tokens, and logout revokes immediately', async t => {
  const f = await fixture(t);
  const account = await bootstrapAdmin(f.store, ADMIN);
  const login = await f.login();
  const cookie = login.response.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(login.body.publicationId, account.tenantId);
  assert.equal(login.body.user.email, ADMIN.email);
  assert.equal(login.body.user.passwordHash, undefined);
  const rawToken = login.cookie.split('=')[1];
  const sessions = await f.store.list('__system__', 'session');
  assert.equal(sessions.items.length, 1);
  assert.ok(!JSON.stringify(sessions).includes(rawToken));
  assert.equal((await f.request('/auth/me', { cookie: login.cookie })).status, 200);
  assert.equal((await f.request('/auth/logout', { method: 'POST', cookie: login.cookie })).status, 200);
  assert.equal((await f.request('/auth/me', { cookie: login.cookie })).status, 401);
  assert.equal((await f.store.list('__system__', 'session')).items.length, 0);
});

test('unknown accounts and wrong passwords have the same generic response and login attempts are limited', async t => {
  const f = await fixture(t);
  await bootstrapAdmin(f.store, ADMIN);
  const unknown = await f.request('/auth/login', { body: { email: 'unknown@example.com', password: PASSWORD } });
  const wrong = await f.request('/auth/login', { body: { email: ADMIN.email, password: 'wrong password value' } });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(await unknown.json(), await wrong.json());
  for (let attempt = 0; attempt < 9; attempt++) assert.equal((await f.request('/auth/login', { body: { email: ADMIN.email, password: 'wrong password value' } })).status, 401);
  assert.equal((await f.request('/auth/login', { body: { email: ADMIN.email, password: PASSWORD } })).status, 429);
});

test('publication switching rotates session and never accepts an unrelated tenant', async t => {
  const f = await fixture(t);
  const account = await bootstrapAdmin(f.store, ADMIN);
  const secondId = await addPublication(f.store, account.userId);
  const login = await f.login();
  const forbidden = await f.request('/auth/switch-publication', { cookie: login.cookie, body: { publicationId: id() } });
  assert.equal(forbidden.status, 403);
  const response = await f.request('/auth/switch-publication', { cookie: login.cookie, body: { publicationId: secondId } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.publicationId, secondId);
  assert.equal(body.role, 'member');
  assert.equal(body.memberships.length, 2);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  assert.notEqual(cookie, login.cookie);
  assert.equal((await f.request('/auth/me', { cookie: login.cookie })).status, 401);
  assert.equal((await f.request('/admin-only', { cookie, method: 'POST' })).status, 403);
  await f.store.remove('__system__', 'membership', membershipId(account.userId, secondId));
  assert.equal((await f.request('/auth/me', { cookie })).status, 401);
});

test('magic links use injected email, generic request responses, 15 minute expiry and atomic single use', async t => {
  const f = await fixture(t);
  await bootstrapAdmin(f.store, ADMIN);
  const known = await f.request('/auth/magic-link', { body: { email: ADMIN.email } });
  const unknown = await f.request('/auth/magic-link', { body: { email: 'unknown@example.com' } });
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(await known.json(), await unknown.json());
  assert.equal(f.messages.length, 1);
  const token = tokenFrom(f.messages[0], 'magic_token');
  const record = await f.store.get('__system__', 'login_token', hash(token));
  assert.ok(record);
  assert.ok(!JSON.stringify(record).includes(token));
  assert.ok(Date.parse(record.data.expiresAt) - Date.now() <= 15 * 60 * 1000);
  const attempts = await Promise.all([f.request('/auth/magic-link/verify', { body: { token } }), f.request('/auth/magic-link/verify', { body: { token } })]);
  assert.deepEqual(attempts.map(response => response.status).sort(), [200, 401]);
  assert.equal(await f.store.get('__system__', 'login_token', hash(token)), null);
  await f.request('/auth/magic-link', { body: { email: ADMIN.email } });
  const expiredToken = tokenFrom(f.messages[1], 'magic_token');
  const expiring = (await f.store.get('__system__', 'login_token', hash(expiredToken)))!;
  await f.store.update('__system__', 'login_token', expiring.id, { ...expiring.data, expiresAt: new Date(Date.now() - 1000).toISOString() }, expiring.version);
  assert.equal((await f.request('/auth/magic-link/verify', { body: { token: expiredToken } })).status, 401);
});

test('missing email configuration fails clearly, and provider failures do not leave usable tokens', async t => {
  const f = await fixture(t);
  await bootstrapAdmin(f.store, ADMIN);
  const originalFrom = config.emailFrom;
  try {
    config.emailFrom = undefined;
    const response = await f.request('/auth/magic-link', { body: { email: ADMIN.email } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'email_not_configured');
    assert.equal(f.messages.length, 0);
  } finally { config.emailFrom = originalFrom; }
  f.services.sendEmail = async () => { throw new Error('Provider unavailable'); };
  assert.equal((await f.request('/auth/magic-link', { body: { email: ADMIN.email } })).status, 503);
  assert.equal((await f.store.list('__system__', 'login_token')).items.length, 0);
});

test('team invitations create real membership, enforce contributor permissions and revoke sessions immediately', async t => {
  const f = await fixture(t);
  const account = await bootstrapAdmin(f.store, ADMIN);
  const admin = await f.login();
  const invite = await f.request('/team/invitations', { cookie: admin.cookie, body: { email: 'writer@example.com', name: 'Writer', role: 'contributor' } });
  assert.equal(invite.status, 201, await invite.clone().text());
  const invitationToken = tokenFrom(f.messages[0], 'invitation_token');
  assert.ok(!JSON.stringify(await invite.json()).includes(invitationToken));
  const accepted = await f.request('/team/invitations/accept', { body: { token: invitationToken, name: 'Writer', password: PASSWORD } });
  assert.equal(accepted.status, 201);
  const memberCookie = accepted.headers.get('set-cookie')!.split(';')[0];
  const member = await accepted.json();
  assert.equal(member.publicationId, account.tenantId);
  assert.equal(member.role, 'contributor');
  assert.equal((await f.request('/team', { cookie: memberCookie })).status, 403);
  assert.equal((await f.request('/api-keys', { cookie: memberCookie })).status, 403);
  assert.equal((await f.request('/team/invitations/accept', { body: { token: invitationToken, name: 'Writer', password: PASSWORD } })).status, 401);
  const memberId = membershipId(member.user.id, account.tenantId);
  assert.equal((await f.request(`/team/${memberId}`, { method: 'PATCH', cookie: admin.cookie, body: { role: 'member' } })).status, 200);
  assert.equal((await f.request('/team', { cookie: memberCookie })).status, 200);
  assert.equal((await f.request(`/team/${memberId}`, { method: 'DELETE', cookie: admin.cookie })).status, 200);
  assert.equal((await f.request('/auth/me', { cookie: memberCookie })).status, 401);
  assert.equal((await f.request(`/team/${membershipId(account.userId, account.tenantId)}`, { method: 'DELETE', cookie: admin.cookie })).status, 409);
  assert.equal((await f.request(`/team/${membershipId(account.userId, account.tenantId)}`, { method: 'PATCH', cookie: admin.cookie, body: { role: 'member' } })).status, 409);
});

test('an existing account must sign in as its invited identity before acceptance', async t => {
  const f = await fixture(t);
  await bootstrapAdmin(f.store, ADMIN);
  await bootstrapAdmin(f.store, { ...ADMIN, email: 'existing@example.com', publicationName: 'Existing workspace' });
  const admin = await f.login();
  await f.request('/team/invitations', { cookie: admin.cookie, body: { email: 'existing@example.com', role: 'member' } });
  const token = tokenFrom(f.messages[0], 'invitation_token');
  assert.equal((await f.request('/team/invitations/accept', { body: { token, name: 'Hijack', password: 'incorrect password proof' } })).status, 403);
  assert.equal((await f.request('/team/invitations/accept', { cookie: admin.cookie, body: { token } })).status, 403);
  const existing = await f.login('existing@example.com');
  assert.equal((await f.request('/team/invitations/accept', { cookie: existing.cookie, body: { token } })).status, 201);
});

test('a previously removed user can accept a fresh invitation with their existing password', async t => {
  const f = await fixture(t);
  const owner = await bootstrapAdmin(f.store, ADMIN);
  const removed = await bootstrapAdmin(f.store, { ...ADMIN, email: 'removed@example.com', publicationName: 'Former publication' });
  await f.store.remove('__system__', 'membership', membershipId(removed.userId, removed.tenantId));
  const admin = await f.login();
  await f.request('/team/invitations', { cookie: admin.cookie, body: { email: 'removed@example.com', role: 'member' } });
  const token = tokenFrom(f.messages[0], 'invitation_token');
  const accepted = await f.request('/team/invitations/accept', { body: { token, password: PASSWORD } });
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).publicationId, owner.tenantId);
  const signedIn = await f.login('removed@example.com');
  assert.equal(signedIn.body.publicationId, owner.tenantId);
});

test('API keys are shown once, stored hashed, scoped, publication-bound and revocable', async t => {
  const f = await fixture(t);
  const account = await bootstrapAdmin(f.store, ADMIN);
  await addPublication(f.store, account.userId);
  const admin = await f.login();
  const created = await f.request('/api-keys', { cookie: admin.cookie, body: { name: 'Read-only posts', scopes: ['posts:read', 'workspace:read'], expiresInDays: 7 } });
  assert.equal(created.status, 201);
  const key = await created.json();
  assert.match(key.key, /^bhk_/);
  const stored = await f.store.get('__system__', 'api_key', key.id);
  assert.equal(key.id, hash(key.key));
  assert.ok(!JSON.stringify(stored).includes(key.key));
  const listed = await f.request('/api-keys', { cookie: admin.cookie });
  assert.ok(!(await listed.text()).includes(key.key));
  assert.equal((await f.request('/protected-posts', { key: key.key })).status, 200);
  assert.equal((await f.request('/admin-only', { key: key.key, method: 'POST' })).status, 403);
  assert.equal((await f.request('/team', { key: key.key })).status, 403);
  assert.equal((await f.request('/api-keys', { key: key.key })).status, 403);
  const me = await f.request('/auth/me', { key: key.key });
  assert.equal((await me.json()).memberships.length, 1);
  assert.equal((await f.request(`/api-keys/${key.id}`, { cookie: admin.cookie, method: 'DELETE' })).status, 200);
  assert.equal((await f.request('/protected-posts', { key: key.key })).status, 401);
});

test('cross-publication team and key identifiers are rejected, and expired sessions cannot authenticate', async t => {
  const f = await fixture(t);
  await bootstrapAdmin(f.store, ADMIN);
  const other = await bootstrapAdmin(f.store, { ...ADMIN, email: 'other@example.com', publicationName: 'Other tenant' });
  const admin = await f.login();
  const otherLogin = await f.login('other@example.com');
  const otherKeyResponse = await f.request('/api-keys', { cookie: otherLogin.cookie, body: { name: 'Other key', scopes: ['posts:read'] } });
  const otherKey = await otherKeyResponse.json();
  assert.equal((await f.request(`/api-keys/${otherKey.id}`, { cookie: admin.cookie, method: 'DELETE' })).status, 404);
  assert.equal((await f.request(`/team/${membershipId(other.userId, other.tenantId)}`, { cookie: admin.cookie, method: 'PATCH', body: { role: 'contributor' } })).status, 404);
  const sessions = await f.store.list('__system__', 'session');
  for (const session of sessions.items) await f.store.update('__system__', 'session', session.id, { ...session.data, expiresAt: new Date(Date.now() - 1000).toISOString() }, session.version);
  assert.equal((await f.request('/auth/me', { cookie: admin.cookie })).status, 401);
});

test('API key expiry and changed membership roles apply on the very next request', async t => {
  const f = await fixture(t);
  const account = await bootstrapAdmin(f.store, ADMIN);
  const admin = await f.login();
  const response = await f.request('/api-keys', { cookie: admin.cookie, body: { name: 'Role verification', scopes: ['posts:read', 'workspace:write'], expiresInDays: 1 } });
  const key = await response.json();
  assert.equal((await f.request('/admin-only', { key: key.key, method: 'POST' })).status, 200);
  const record = (await f.store.get('__system__', 'api_key', key.id))!;
  const expired = await f.store.update('__system__', 'api_key', record.id, { ...record.data, expiresAt: new Date(Date.now() - 1000).toISOString() }, record.version);
  assert.equal((await f.request('/protected-posts', { key: key.key })).status, 401);
  await f.store.update('__system__', 'api_key', record.id, { ...expired.data, expiresAt: null }, expired.version);
  const membership = (await f.store.get('__system__', 'membership', membershipId(account.userId, account.tenantId)))!;
  await f.store.update('__system__', 'membership', membership.id, { ...membership.data, role: 'member' }, membership.version);
  assert.equal((await f.request('/admin-only', { key: key.key, method: 'POST' })).status, 403);
  assert.equal((await f.request('/protected-posts', { key: key.key })).status, 200);
  await f.store.remove('__system__', 'membership', membership.id);
  assert.equal((await f.request('/protected-posts', { key: key.key })).status, 401);
});

test('concurrent bootstrap attempts create exactly one account and one publication', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([bootstrapAdmin(f.store, ADMIN), bootstrapAdmin(f.store, { ...ADMIN, email: 'ADMIN@example.com' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(failure.reason instanceof ApiError && failure.reason.status === 409);
  assert.equal((await f.store.list('__system__', 'user')).items.length, 1);
  assert.equal((await f.store.list('__system__', 'tenant')).items.length, 1);
  assert.equal((await f.store.list('__system__', 'membership')).items.length, 1);
});

test('production authentication requires a long session secret and sends Secure cookies', async t => {
  const f = await fixture(t);
  await bootstrapAdmin(f.store, ADMIN);
  const original = { production: config.production, sessionSecret: config.sessionSecret };
  try {
    config.production = true;
    config.sessionSecret = undefined;
    assert.equal((await f.request('/auth/login', { body: { email: ADMIN.email, password: PASSWORD } })).status, 503);
    config.sessionSecret = 'production-test-secret-with-more-than-32-characters';
    const login = await f.login();
    assert.match(login.response.headers.get('set-cookie')!, /; Secure/);
  } finally { Object.assign(config, original); }
});
