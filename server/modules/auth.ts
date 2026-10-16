import { createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { Api, Ctx, Principal, Role, Services, Store, Stored, Variables } from '../contracts.js';
import { config } from '../core/config.js';
import { ApiError, audit, hash, id, jsonBody, principal, randomToken, requireRole, requireScope } from '../core/http.js';
import { rateLimit, requestIp } from '../core/security.js';

const SYSTEM = '__system__';
const COOKIE = 'bh_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const MAGIC_SECONDS = 15 * 60;
const INVITATION_SECONDS = 7 * 24 * 60 * 60;
const PASSWORD_COST = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DEV_SESSION_SECRET = randomBytes(32).toString('hex');
const DUMMY_SALT = Buffer.from('8a095ec26a353aabf11efea7ff08fa04', 'hex');
const DUMMY_KEY = Buffer.alloc(64, 73);
const roles = ['admin', 'member', 'contributor'] as const;
export const API_SCOPES = [
  'workspace:read', 'workspace:write', 'subscribers:read', 'subscribers:write',
  'posts:read', 'posts:write', 'posts:send', 'segments:read', 'segments:write',
  'automations:read', 'automations:write', 'products:read', 'products:write',
  'commerce:read', 'commerce:write', 'community:read', 'community:write',
  'podcasts:read', 'podcasts:write', 'content:read', 'content:write',
  'integrations:read', 'integrations:write', 'analytics:read', 'ai:write',
  'media:read', 'media:write', 'team:read', 'team:write',
  'domains:write', 'growth:read', 'growth:write',
] as const;

const emailSchema = z.string().trim().max(254).email().transform(value => value.toLowerCase());
const passwordSchema = z.string().min(12).max(1024);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(1024) }).strict();
const inviteSchema = z.object({ email: emailSchema, name: z.string().trim().max(120).optional(), role: z.enum(roles).default('member') }).strict();
type UserData = { email: string; name: string; passwordHash: string; disabled: boolean; defaultTenantId?: string };
type MembershipData = { userId: string; tenantId: string; role: Role; email: string; name: string };

export function membershipId(userId: string, tenantId: string): string {
  return hash(`${userId}:${tenantId}`);
}

function userIdFor(email: string): string { return hash(email.trim().toLowerCase()); }
function expiresIn(seconds: number): string { return new Date(Date.now() + seconds * 1000).toISOString(); }
function unexpired(value: unknown): boolean { return typeof value === 'string' && Date.parse(value) > Date.now(); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!)); }
function clientAddress(c: Ctx): string {
  return requestIp(c.req.raw.headers).slice(0, 128);
}

function sessionTokenHash(token: string): string {
  if (config.production && (!config.sessionSecret || config.sessionSecret.length < 32)) {
    throw new ApiError(503, 'auth_not_configured', 'SESSION_SECRET must contain at least 32 characters in production.');
  }
  return createHmac('sha256', config.sessionSecret || DEV_SESSION_SECRET).update(token).digest('hex');
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => nodeScrypt(password, salt, 64, PASSWORD_COST, (error, derived) => error ? reject(error) : resolve(derived)));
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt);
  return `scrypt$32768$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password: string, encoded?: string): Promise<boolean> {
  const parts = encoded?.split('$');
  const valid = !!parts && parts.length === 6 && parts.slice(0, 4).join('$') === 'scrypt$32768$8$1' && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{128}$/.test(parts[5]);
  const salt = valid ? Buffer.from(parts![4], 'hex') : DUMMY_SALT;
  const expected = valid ? Buffer.from(parts![5], 'hex') : DUMMY_KEY;
  const actual = await derivePassword(password, salt);
  return timingSafeEqual(actual, expected) && valid;
}

async function fixedMinimum(start: number): Promise<void> {
  const remaining = 250 - (performance.now() - start);
  if (remaining > 0) await delay(remaining);
}

function loginError(): ApiError { return new ApiError(401, 'invalid_credentials', 'Invalid email or password.'); }
function tokenError(): ApiError { return new ApiError(401, 'invalid_token', 'This link is invalid or has expired.'); }

async function membership(store: Store, userId: string, tenantId: string): Promise<Stored<MembershipData> | null> {
  const record = await store.get<MembershipData>(SYSTEM, 'membership', membershipId(userId, tenantId));
  return record && record.data.userId === userId && record.data.tenantId === tenantId && roles.includes(record.data.role) ? record : null;
}

async function userMemberships(store: Store, userId: string): Promise<Stored<MembershipData>[]> {
  const records: Stored<MembershipData>[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list<MembershipData>(SYSTEM, 'membership', { filters: { userId }, limit: 100, cursor });
    records.push(...page.items.filter(record => roles.includes(record.data.role)));
    cursor = page.nextCursor || undefined;
  } while (cursor);
  return records;
}

async function tenantMemberships(store: Store, tenantId: string): Promise<Stored<MembershipData>[]> {
  const records: Stored<MembershipData>[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list<MembershipData>(SYSTEM, 'membership', { filters: { tenantId }, limit: 100, cursor });
    records.push(...page.items);
    cursor = page.nextCursor || undefined;
  } while (cursor);
  return records;
}

function cookieOptions() {
  return { httpOnly: true, secure: config.production || config.appUrl.startsWith('https://'), sameSite: 'Lax' as const, path: '/', maxAge: SESSION_SECONDS };
}

async function createSession(store: Store, userId: string, tenantId: string): Promise<{ token: string; sessionId: string }> {
  const token = randomToken();
  const sessionId = sessionTokenHash(token);
  await store.insert(SYSTEM, 'session', { userId, tenantId, expiresAt: expiresIn(SESSION_SECONDS) }, sessionId);
  return { token, sessionId };
}

async function accountPayload(store: Store, actor: Principal) {
  const user = await store.get<UserData>(SYSTEM, 'user', actor.userId);
  if (!user || user.data.disabled) throw new ApiError(401, 'unauthorized', 'Authentication required.');
  const memberships = (await userMemberships(store, actor.userId)).filter(member => !actor.apiKeyId || member.data.tenantId === actor.tenantId);
  const publications = await Promise.all(memberships.map(async record => {
    const tenant = await store.get(SYSTEM, 'tenant', record.data.tenantId);
    return { id: record.data.tenantId, tenantId: record.data.tenantId, publicationId: record.data.tenantId, name: tenant?.data.name || 'Publication', role: record.data.role };
  }));
  return {
    user: { id: user.id, email: user.data.email, name: user.data.name },
    tenantId: actor.tenantId,
    publicationId: actor.tenantId,
    role: actor.role,
    memberships: publications,
  };
}

function sessionActor(c: Ctx, admin = false): Principal {
  const actor = principal(c);
  if (!actor.sessionId || actor.apiKeyId) throw new ApiError(403, 'session_required', 'Sign in with a user account to perform this action.');
  if (admin) requireRole(c, 'admin');
  return actor;
}

function teamActor(c: Ctx, write = false): Principal {
  const actor = principal(c);
  requireScope(c, write ? 'team:write' : 'team:read');
  requireRole(c, ...(write ? ['admin'] as const : ['admin', 'member'] as const));
  return actor;
}

function requireEmailConfiguration(): string {
  if (!config.emailFrom || !config.resendApiKey) throw new ApiError(503, 'email_not_configured', 'Set EMAIL_FROM and RESEND_API_KEY before sending login links or invitations.');
  return config.emailFrom;
}

async function sendAuthEmail(services: Services, message: Parameters<Services['sendEmail']>[0]): Promise<void> {
  try { await services.sendEmail(message); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'email_unavailable', 'The email provider could not send this message. Please try again later.');
  }
}

/** Authentication is optional here; protected routes must call principal/requireRole/requireScope. */
export function authenticate(services: Services): MiddlewareHandler<{ Variables: Variables }> {
  return async (c, next) => {
    const authorization = c.req.header('authorization');
    let record: Stored | null = null;
    let apiKey = false;
    if (authorization) {
      const match = /^Bearer (bhk_[A-Za-z0-9_-]{43})$/i.exec(authorization);
      if (match) {
        record = await services.store.get(SYSTEM, 'api_key', hash(match[1]));
        apiKey = true;
      }
    } else {
      const token = getCookie(c, COOKIE);
      if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) record = await services.store.get(SYSTEM, 'session', sessionTokenHash(token));
    }
    if (record && (apiKey ? !record.data.expiresAt || unexpired(record.data.expiresAt) : unexpired(record.data.expiresAt))) {
      const [user, member] = await Promise.all([
        services.store.get<UserData>(SYSTEM, 'user', record.data.userId),
        membership(services.store, record.data.userId, record.data.tenantId),
      ]);
      if (user && !user.data.disabled && member) {
        c.set('principal', {
          userId: user.id, tenantId: member.data.tenantId, role: member.data.role,
          ...(apiKey ? { apiKeyId: record.id, scopes: Array.isArray(record.data.scopes) ? record.data.scopes : [] } : { sessionId: record.id }),
        });
      }
    }
    await next();
  };
}

/** Local CLI only. There is deliberately no HTTP bootstrap endpoint. */
export async function bootstrapAdmin(store: Store, input: { email: string; password: string; name: string; publicationName: string }) {
  const parsed = z.object({ email: emailSchema, password: passwordSchema, name: z.string().trim().min(1).max(120), publicationName: z.string().trim().min(1).max(120) }).strict().parse(input);
  const userId = userIdFor(parsed.email);
  const passwordHash = await hashPassword(parsed.password);
  return store.transaction(async tx => {
    await tx.lock(`bootstrap:${userId}`);
    if (await tx.get(SYSTEM, 'user', userId)) throw new ApiError(409, 'account_exists', 'An account already exists for this email.');
    const tenantId = id();
    const slug = `${parsed.publicationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'publication'}-${tenantId.slice(0, 8)}`;
    await tx.insert<UserData>(SYSTEM, 'user', { email: parsed.email, name: parsed.name, passwordHash, disabled: false, defaultTenantId: tenantId }, userId);
    await tx.insert(SYSTEM, 'tenant', { name: parsed.publicationName, slug, ownerId: userId }, tenantId);
    await tx.insert(tenantId, 'publication', { name: parsed.publicationName, description: '', domain: '', sender: parsed.email, accent: '#ec73a4', slug, verifiedDomain: false }, tenantId);
    await tx.insert<MembershipData>(SYSTEM, 'membership', { userId, tenantId, role: 'admin', email: parsed.email, name: parsed.name }, membershipId(userId, tenantId));
    return { userId, tenantId, publicationId: tenantId, role: 'admin' as const };
  });
}

export function registerAuth(app: Api, services: Services): void {
  app.post('/auth/login', async c => {
    const start = performance.now();
    const body = await jsonBody(c, loginSchema);
    await rateLimit(services, `login:ip:${hash(clientAddress(c))}`, 30, 15 * 60);
    await rateLimit(services, `login:email:${hash(body.email)}`, 10, 15 * 60);
    const user = await services.store.get<UserData>(SYSTEM, 'user', userIdFor(body.email));
    const valid = await verifyPassword(body.password, user?.data.passwordHash);
    const memberships = user && valid && !user.data.disabled ? await userMemberships(services.store, user.id) : [];
    await fixedMinimum(start);
    if (!valid || !user || user.data.disabled || !memberships.length) throw loginError();
    const selected = memberships.find(member => member.data.tenantId === user.data.defaultTenantId) || memberships[0];
    const session = await services.store.transaction(async tx => {
      await tx.lock(`membership:${selected.data.tenantId}`);
      if (!await membership(tx, user.id, selected.data.tenantId)) throw loginError();
      return createSession(tx, user.id, selected.data.tenantId);
    });
    // Rotate any presented session so a password login cannot preserve a fixed session token.
    const priorToken = getCookie(c, COOKIE);
    if (priorToken && /^[A-Za-z0-9_-]{43}$/.test(priorToken)) await services.store.remove(SYSTEM, 'session', sessionTokenHash(priorToken));
    setCookie(c, COOKIE, session.token, cookieOptions());
    const actor: Principal = { userId: user.id, tenantId: selected.data.tenantId, role: selected.data.role, sessionId: session.sessionId };
    await audit(services, actor, 'auth.login', {});
    return c.json(await accountPayload(services.store, actor));
  });

  app.post('/auth/logout', async c => {
    const token = getCookie(c, COOKIE);
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) await services.store.remove(SYSTEM, 'session', sessionTokenHash(token));
    deleteCookie(c, COOKIE, { path: '/', httpOnly: true, secure: cookieOptions().secure, sameSite: 'Lax' });
    return c.json({ ok: true });
  });

  app.get('/auth/me', async c => {
    const actor = principal(c);
    requireScope(c, 'workspace:read');
    return c.json(await accountPayload(services.store, actor));
  });

  app.post('/auth/switch-publication', async c => {
    const actor = sessionActor(c);
    const body = await jsonBody(c, z.object({ publicationId: z.string().uuid() }).strict());
    const result = await services.store.transaction(async tx => {
      await tx.lock(`membership:${body.publicationId}`);
      const member = await membership(tx, actor.userId, body.publicationId);
      if (!member) throw new ApiError(403, 'forbidden', 'You do not have access to this publication.');
      const session = await tx.get(SYSTEM, 'session', actor.sessionId!);
      if (!session || !unexpired(session.data.expiresAt)) throw new ApiError(401, 'unauthorized', 'Authentication required.');
      await tx.remove(SYSTEM, 'session', session.id, session.version);
      return { member, session: await createSession(tx, actor.userId, body.publicationId) };
    });
    setCookie(c, COOKIE, result.session.token, cookieOptions());
    return c.json(await accountPayload(services.store, { userId: actor.userId, tenantId: body.publicationId, role: result.member.data.role, sessionId: result.session.sessionId }));
  });

  app.post('/auth/magic-link', async c => {
    const start = performance.now();
    const body = await jsonBody(c, z.object({ email: emailSchema }).strict());
    await rateLimit(services, `magic:ip:${hash(clientAddress(c))}`, 10, 15 * 60);
    await rateLimit(services, `magic:email:${hash(body.email)}`, 3, 15 * 60);
    const from = requireEmailConfiguration();
    const user = await services.store.get<UserData>(SYSTEM, 'user', userIdFor(body.email));
    const memberships = user && !user.data.disabled ? await userMemberships(services.store, user.id) : [];
    if (user && memberships.length) {
      const token = randomToken();
      const tokenHash = hash(token);
      const selected = memberships.find(member => member.data.tenantId === user.data.defaultTenantId) || memberships[0];
      await services.store.insert(SYSTEM, 'login_token', { userId: user.id, tenantId: selected.data.tenantId, expiresAt: expiresIn(MAGIC_SECONDS) }, tokenHash);
      const link = new URL('/', config.appUrl);
      link.searchParams.set('magic_token', token);
      try {
        await sendAuthEmail(services, { to: user.data.email, from, subject: 'Your sign-in link', html: `<p>Use this single-use link to sign in. It expires in 15 minutes.</p><p><a href="${escapeHtml(link.href)}">Sign in to your newsletter workspace</a></p><p>If you did not request this, you can ignore this email.</p>`, text: `Sign in to your newsletter workspace: ${link.href}\nThis single-use link expires in 15 minutes. If you did not request this, ignore this email.` });
      } catch (error) {
        await services.store.remove(SYSTEM, 'login_token', tokenHash);
        throw error;
      }
    }
    await fixedMinimum(start);
    return c.json({ message: 'If an eligible account exists, a sign-in link has been sent.' }, 202);
  });

  app.post('/auth/magic-link/verify', async c => {
    const start = performance.now();
    const body = await jsonBody(c, z.object({ token: tokenSchema }).strict());
    await rateLimit(services, `magic-verify:${hash(clientAddress(c))}`, 30, 15 * 60);
    const tokenHash = hash(body.token);
    let result: { actor: Principal; token: string };
    try {
      result = await services.store.transaction(async tx => {
        await tx.lock(`login-token:${tokenHash}`);
        const record = await tx.get(SYSTEM, 'login_token', tokenHash);
        if (!record || !unexpired(record.data.expiresAt)) throw tokenError();
        const [user, member] = await Promise.all([tx.get<UserData>(SYSTEM, 'user', record.data.userId), membership(tx, record.data.userId, record.data.tenantId)]);
        if (!user || user.data.disabled || !member) throw tokenError();
        await tx.remove(SYSTEM, 'login_token', record.id, record.version);
        const session = await createSession(tx, user.id, member.data.tenantId);
        return { actor: { userId: user.id, tenantId: member.data.tenantId, role: member.data.role, sessionId: session.sessionId }, token: session.token };
      });
    } finally { await fixedMinimum(start); }
    setCookie(c, COOKIE, result.token, cookieOptions());
    await audit(services, result.actor, 'auth.magic_login', {});
    return c.json(await accountPayload(services.store, result.actor));
  });

  app.get('/team', async c => {
    const actor = teamActor(c);
    const members = await tenantMemberships(services.store, actor.tenantId);
    return c.json({ items: members.map(member => ({ id: member.id, userId: member.data.userId, email: member.data.email, name: member.data.name, role: member.data.role })) });
  });

  app.patch('/team/:memberId', async c => {
    const actor = teamActor(c, true);
    const body = await jsonBody(c, z.object({ role: z.enum(roles) }).strict());
    const result = await services.store.transaction(async tx => {
      await tx.lock(`membership:${actor.tenantId}`);
      const currentActor = await membership(tx, actor.userId, actor.tenantId);
      if (!currentActor || currentActor.data.role !== 'admin') throw new ApiError(403, 'forbidden', 'Administrator access required.');
      const member = await tx.get<MembershipData>(SYSTEM, 'membership', c.req.param('memberId'));
      if (!member || member.data.tenantId !== actor.tenantId) throw new ApiError(404, 'not_found', 'Team member not found.');
      if (member.data.role === 'admin' && body.role !== 'admin') {
        const admins = (await tenantMemberships(tx, actor.tenantId)).filter(item => item.data.role === 'admin');
        if (admins.length <= 1) throw new ApiError(409, 'last_admin', 'A publication must keep at least one administrator.');
      }
      return tx.update(SYSTEM, 'membership', member.id, { ...member.data, role: body.role }, member.version);
    });
    await audit(services, actor, 'team.role_changed', { memberId: result.id, role: body.role });
    return c.json({ id: result.id, ...result.data });
  });

  app.delete('/team/:memberId', async c => {
    const actor = teamActor(c, true);
    await services.store.transaction(async tx => {
      await tx.lock(`membership:${actor.tenantId}`);
      const currentActor = await membership(tx, actor.userId, actor.tenantId);
      if (!currentActor || currentActor.data.role !== 'admin') throw new ApiError(403, 'forbidden', 'Administrator access required.');
      const member = await tx.get<MembershipData>(SYSTEM, 'membership', c.req.param('memberId'));
      if (!member || member.data.tenantId !== actor.tenantId) throw new ApiError(404, 'not_found', 'Team member not found.');
      if (member.data.role === 'admin' && (await tenantMemberships(tx, actor.tenantId)).filter(item => item.data.role === 'admin').length <= 1) throw new ApiError(409, 'last_admin', 'A publication must keep at least one administrator.');
      await tx.remove(SYSTEM, 'membership', member.id, member.version);
    });
    await audit(services, actor, 'team.removed', { memberId: c.req.param('memberId') });
    return c.json({ ok: true });
  });

  app.get('/team/invitations', async c => {
    const actor = teamActor(c, true);
    const page = await services.store.list(SYSTEM, 'invitation', { filters: { tenantId: actor.tenantId }, limit: 100, cursor: c.req.query('cursor') });
    return c.json({ items: page.items.map(item => ({ id: item.id, email: item.data.email, name: item.data.name, role: item.data.role, expiresAt: item.data.expiresAt, expired: !unexpired(item.data.expiresAt) })), nextCursor: page.nextCursor });
  });

  app.post('/team/invitations', async c => {
    const actor = teamActor(c, true);
    const body = await jsonBody(c, inviteSchema);
    await rateLimit(services, `invitation:${actor.tenantId}`, 30, 60 * 60);
    const from = requireEmailConfiguration();
    const token = randomToken();
    const tokenHash = hash(token);
    const invitation = await services.store.transaction(async tx => {
      await tx.lock(`membership:${actor.tenantId}`);
      if ((await membership(tx, actor.userId, actor.tenantId))?.data.role !== 'admin') throw new ApiError(403, 'forbidden', 'Administrator access required.');
      if (await membership(tx, userIdFor(body.email), actor.tenantId)) throw new ApiError(409, 'already_member', 'This person is already a member of the publication.');
      const previous = await tx.list(SYSTEM, 'invitation', { filters: { email: body.email, tenantId: actor.tenantId }, limit: 100 });
      for (const record of previous.items) await tx.remove(SYSTEM, 'invitation', record.id, record.version);
      return tx.insert(SYSTEM, 'invitation', { tenantId: actor.tenantId, email: body.email, name: body.name || '', role: body.role, invitedBy: actor.userId, expiresAt: expiresIn(INVITATION_SECONDS) }, tokenHash);
    });
    const tenant = await services.store.get(SYSTEM, 'tenant', actor.tenantId);
    const link = new URL('/', config.appUrl);
    link.searchParams.set('invitation_token', token);
    try {
      await sendAuthEmail(services, { to: body.email, from, subject: `Invitation to ${tenant?.data.name || 'your newsletter workspace'}`, html: `<p>You have been invited to ${escapeHtml(tenant?.data.name || 'a newsletter workspace')} as a ${escapeHtml(body.role)}.</p><p><a href="${escapeHtml(link.href)}">Accept invitation</a></p><p>This single-use invitation expires in 7 days.</p>`, text: `Accept your invitation: ${link.href}\nThis single-use invitation expires in 7 days.` });
    } catch (error) {
      await services.store.remove(SYSTEM, 'invitation', invitation.id);
      throw error;
    }
    await audit(services, actor, 'team.invited', { email: body.email, role: body.role });
    return c.json({ id: invitation.id, email: body.email, role: body.role, expiresAt: invitation.data.expiresAt }, 201);
  });

  app.delete('/team/invitations/:invitationId', async c => {
    const actor = teamActor(c, true);
    const invitation = await services.store.get(SYSTEM, 'invitation', c.req.param('invitationId'));
    if (!invitation || invitation.data.tenantId !== actor.tenantId) throw new ApiError(404, 'not_found', 'Invitation not found.');
    await services.store.remove(SYSTEM, 'invitation', invitation.id, invitation.version);
    await audit(services, actor, 'team.invitation_revoked', { invitationId: invitation.id });
    return c.json({ ok: true });
  });

  app.post('/team/invitations/accept', async c => {
    const body = await jsonBody(c, z.object({ token: tokenSchema, name: z.string().trim().min(1).max(120).optional(), password: passwordSchema.optional() }).strict());
    await rateLimit(services, `accept-invitation:${hash(clientAddress(c))}`, 20, 15 * 60);
    const tokenHash = hash(body.token);
    // Verify/hash before taking SQL locks. An existing account can prove its password even
    // after its final membership was removed, without turning an invite into a password reset.
    const previewInvitation = await services.store.get(SYSTEM, 'invitation', tokenHash);
    const previewUser = previewInvitation ? await services.store.get<UserData>(SYSTEM, 'user', userIdFor(previewInvitation.data.email)) : null;
    const passwordProof = !!body.password && !!previewUser && await verifyPassword(body.password, previewUser.data.passwordHash);
    const passwordHash = body.password && !previewUser ? await hashPassword(body.password) : undefined;
    const existingActor = c.get('principal') as Principal | undefined;
    const result = await services.store.transaction(async tx => {
      await tx.lock(`invitation:${tokenHash}`);
      const invitation = await tx.get(SYSTEM, 'invitation', tokenHash);
      if (!invitation || !unexpired(invitation.data.expiresAt)) throw tokenError();
      await tx.lock(`membership:${invitation.data.tenantId}`);
      if ((await membership(tx, invitation.data.invitedBy, invitation.data.tenantId))?.data.role !== 'admin') throw tokenError();
      const userId = userIdFor(invitation.data.email);
      await tx.lock(`bootstrap:${userId}`);
      let user = await tx.get<UserData>(SYSTEM, 'user', userId);
      if (user) {
        const signedInAsInvitee = !!existingActor?.sessionId && existingActor.userId === user.id;
        const passwordStillValid = passwordProof && previewUser?.id === user.id && previewUser.version === user.version;
        if (user.data.disabled || !signedInAsInvitee && !passwordStillValid) throw new ApiError(403, 'sign_in_required', 'Sign in with the invited email address or enter its current password to accept this invitation.');
      } else {
        if (!passwordHash || !body.name) throw new ApiError(400, 'account_details_required', 'A name and password of at least 12 characters are required for a new account.');
        user = await tx.insert<UserData>(SYSTEM, 'user', { email: invitation.data.email, name: body.name, passwordHash, disabled: false, defaultTenantId: invitation.data.tenantId }, userId);
      }
      if (await membership(tx, userId, invitation.data.tenantId)) throw new ApiError(409, 'already_member', 'You are already a member of this publication.');
      const role: Role = invitation.data.role;
      await tx.insert<MembershipData>(SYSTEM, 'membership', { userId, tenantId: invitation.data.tenantId, role, email: user.data.email, name: user.data.name }, membershipId(userId, invitation.data.tenantId));
      await tx.remove(SYSTEM, 'invitation', invitation.id, invitation.version);
      const session = await createSession(tx, userId, invitation.data.tenantId);
      return { token: session.token, actor: { userId, tenantId: invitation.data.tenantId, role, sessionId: session.sessionId } satisfies Principal };
    });
    setCookie(c, COOKIE, result.token, cookieOptions());
    await audit(services, result.actor, 'team.invitation_accepted', {});
    return c.json(await accountPayload(services.store, result.actor), 201);
  });

  app.get('/api-keys', async c => {
    const actor = sessionActor(c, true);
    const page = await services.store.list(SYSTEM, 'api_key', { filters: { tenantId: actor.tenantId }, limit: 100, cursor: c.req.query('cursor') });
    return c.json({ items: page.items.map(key => ({ id: key.id, name: key.data.name, prefix: key.data.prefix, scopes: key.data.scopes, userId: key.data.userId, createdAt: key.createdAt, expiresAt: key.data.expiresAt || null })), nextCursor: page.nextCursor, availableScopes: API_SCOPES });
  });

  app.post('/api-keys', async c => {
    const actor = sessionActor(c, true);
    const body = await jsonBody(c, z.object({ name: z.string().trim().min(1).max(120), scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length), expiresInDays: z.number().int().min(1).max(365).optional() }).strict());
    await rateLimit(services, `api-keys:${actor.tenantId}`, 30, 60 * 60);
    const token = `bhk_${randomToken()}`;
    const record = await services.store.transaction(async tx => {
      await tx.lock(`membership:${actor.tenantId}`);
      if ((await membership(tx, actor.userId, actor.tenantId))?.data.role !== 'admin') throw new ApiError(403, 'forbidden', 'Administrator access required.');
      return tx.insert(SYSTEM, 'api_key', { userId: actor.userId, tenantId: actor.tenantId, role: actor.role, name: body.name, scopes: [...new Set(body.scopes)], prefix: token.slice(0, 12), expiresAt: body.expiresInDays ? expiresIn(body.expiresInDays * 86400) : null }, hash(token));
    });
    await audit(services, actor, 'api_key.created', { keyId: record.id, name: body.name, scopes: record.data.scopes });
    return c.json({ id: record.id, name: body.name, key: token, scopes: record.data.scopes, expiresAt: record.data.expiresAt, message: 'Copy this key now. It will not be shown again.' }, 201);
  });

  app.delete('/api-keys/:keyId', async c => {
    const actor = sessionActor(c, true);
    const record = await services.store.get(SYSTEM, 'api_key', c.req.param('keyId'));
    if (!record || record.data.tenantId !== actor.tenantId) throw new ApiError(404, 'not_found', 'API key not found.');
    await services.store.remove(SYSTEM, 'api_key', record.id, record.version);
    await audit(services, actor, 'api_key.revoked', { keyId: record.id });
    return c.json({ ok: true });
  });
}
