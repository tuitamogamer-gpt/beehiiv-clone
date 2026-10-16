import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import type { Api, Ctx, Services } from '../contracts.js';
import { ApiError, hash, jsonBody, now, randomToken } from '../core/http.js';
import { emailSendEligibility } from './audience.js';
import { registerProviderMessage } from './delivery.js';
import { config } from '../core/config.js';
import { rateLimit, requestIp, resolvePublicTenant, verifyBotToken } from '../core/security.js';

export type ReaderIdentity = { tenantId: string; userId: string; subscriberId: string; email: string; name: string; sessionId: string };
const COOKIE = 'bh_reader';
function protectToken(token: string) { if (!config.sessionSecret) throw new ApiError(503, 'auth_not_configured', 'Configure the session encryption secret.'); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(config.sessionSecret).digest(), iv); const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]); return { iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }; }
function revealToken(value: { iv: string; ciphertext: string; tag: string }) { if (!config.sessionSecret) throw new ApiError(503, 'auth_not_configured', 'Configure the session encryption secret.'); const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(config.sessionSecret).digest(), Buffer.from(value.iv, 'base64url')); decipher.setAuthTag(Buffer.from(value.tag, 'base64url')); return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()]).toString('utf8'); }
const confirmation = { message: 'If this email belongs to a subscribed reader, a sign-in link will arrive shortly.' };
export function assertReaderOrigin(c: Ctx) { if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return; const origin = c.req.header('origin'); if (!origin || origin !== new URL(config.appUrl).origin) throw new ApiError(403, 'invalid_origin', 'Reader account changes must come from this publication website.'); }
export async function readerIdentity(c: Ctx, services: Services, tenantId: string): Promise<ReaderIdentity> {
 assertReaderOrigin(c); const raw = getCookie(c, COOKIE); if (!raw || !/^[A-Za-z0-9_-]{40,100}$/.test(raw)) throw new ApiError(401, 'reader_login_required', 'Sign in with the email address subscribed to this publication.');
 const session = await services.store.get(tenantId, 'reader_session', hash(raw)); if (!session || session.data.revoked || Date.parse(session.data.expiresAt) <= Date.now()) throw new ApiError(401, 'reader_session_expired', 'Your reader session has expired. Sign in again.');
 const subscriber = await services.store.get(tenantId, 'subscriber', session.data.subscriberId); if (!subscriber || subscriber.data.status !== 'Active' || subscriber.data.readerUserId !== session.data.userId) throw new ApiError(401, 'reader_access_revoked', 'This reader account is no longer active.');
 return { tenantId, userId: session.data.userId, subscriberId: subscriber.id, email: subscriber.data.email, name: subscriber.data.name || '', sessionId: session.id };
}
export async function publicReader(c: Ctx, services: Services) { return readerIdentity(c, services, await resolvePublicTenant(services.store, c.req.param('slug')!)); }
export function registerReaders(app: Api, services: Services): void {
 services.registerJob('reader.login_email', async (job, store) => {
  const record = await store.get(job.tenantId, 'reader_magic_token', job.data.payload.tokenId); if (!record || record.data.usedAt || Date.parse(record.data.expiresAt) <= Date.now()) return;
  if (!record.data.subscriberId) return; const subscriber = await store.get(job.tenantId, 'subscriber', record.data.subscriberId); if (!subscriber || subscriber.data.status !== 'Active') return;
  const eligibility = await emailSendEligibility(store, job.tenantId, subscriber.id, 'transactional'); if (!eligibility.eligible) return;
  if (!config.emailFrom) throw new ApiError(503, 'email_not_configured', 'Configure a verified transactional sender for reader login.');
  const url = `${config.appUrl}/api/public/${encodeURIComponent(job.data.payload.slug)}/reader/verify?token=${encodeURIComponent(revealToken(job.data.payload.encryptedToken))}`;
  const escaped = url.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const message = await services.sendEmail({ to: subscriber.data.email, from: config.emailFrom, subject: 'Your secure reader sign-in link', html: `<p>Sign in to your reader account:</p><p><a href="${escaped}">Continue to your publication</a></p><p>This single-use link expires in 15 minutes. If you did not request it, you can ignore this email.</p>`, text: `Sign in to your reader account: ${url}\nThis single-use link expires in 15 minutes.`, idempotencyKey: `reader-login:${record.id}` });
  await registerProviderMessage(store, job.tenantId, message.id, { subscriberId: subscriber.id });
 });
 app.post('/public/:slug/reader/login', async c => {
  const tenantId = await resolvePublicTenant(services.store, c.req.param('slug')!);
  const body = await jsonBody(c, z.object({ email: z.string().trim().email().max(320).transform(email => email.toLowerCase()), botToken: z.string().max(4096).optional() }).strict());
  await rateLimit(services, `reader-login-ip:${requestIp(c.req.raw.headers)}`, 20, 300); await rateLimit(services, `reader-login-email:${tenantId}:${hash(body.email)}`, 3, 300); await verifyBotToken(body.botToken, requestIp(c.req.raw.headers));
  if (!config.resendApiKey || !config.emailFrom) throw new ApiError(503, 'email_not_configured', 'Reader sign-in requires a configured transactional email provider.');
  // Always enqueue the same kind of work and return the same response, whether or not the address exists.
  const token = randomToken(); const tokenId = hash(token); const subscriber = (await services.store.list(tenantId, 'subscriber', { filters: { email: body.email, status: 'Active' }, limit: 1 })).items[0];
  await services.store.transaction(async tx => { await tx.insert(tenantId, 'reader_magic_token', { subscriberId: subscriber?.id || null, expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), usedAt: null }, tokenId); await services.enqueue({ tenantId, type: 'reader.login_email', payload: { tokenId, encryptedToken: protectToken(token), slug: c.req.param('slug')! }, idempotencyKey: tokenId, maxAttempts: 4 }, tx); });
  return c.json(confirmation, 202);
 });
 async function verify(c: Ctx) {
  assertReaderOrigin(c);
  const tenantId = await resolvePublicTenant(services.store, c.req.param('slug')!); await rateLimit(services, `reader-verify:${requestIp(c.req.raw.headers)}`, 30, 300);
  const token = c.req.method === 'GET' ? c.req.query('token') : (await jsonBody(c, z.object({ token: z.string().min(40).max(100) }).strict())).token;
  if (!token || !/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new ApiError(401, 'invalid_reader_link', 'This sign-in link is invalid or expired.');
  const sessionToken = randomToken(); const sessionId = hash(sessionToken);
  const identity = await services.store.transaction(async tx => {
   await tx.lock(`reader-login:${tenantId}:${hash(token)}`); const magic = await tx.get(tenantId, 'reader_magic_token', hash(token));
   if (!magic || magic.data.usedAt || Date.parse(magic.data.expiresAt) <= Date.now() || !magic.data.subscriberId) throw new ApiError(401, 'invalid_reader_link', 'This sign-in link is invalid or expired.');
   const subscriber = await tx.get(tenantId, 'subscriber', magic.data.subscriberId); if (!subscriber || subscriber.data.status !== 'Active') throw new ApiError(401, 'invalid_reader_link', 'This sign-in link is invalid or expired.');
   const userId = `reader:${subscriber.id}`; await tx.update(tenantId, 'reader_magic_token', magic.id, { ...magic.data, usedAt: now() }, magic.version);
   await tx.update(tenantId, 'subscriber', subscriber.id, { ...subscriber.data, readerUserId: userId }, subscriber.version);
   await tx.insert(tenantId, 'reader_session', { userId, subscriberId: subscriber.id, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), revoked: false }, sessionId);
   return { tenantId, userId, subscriberId: subscriber.id, email: subscriber.data.email, name: subscriber.data.name || '' };
  });
  setCookie(c, COOKIE, sessionToken, { httpOnly: true, secure: config.production || config.appUrl.startsWith('https:'), sameSite: 'Lax', path: '/api/public', maxAge: 30 * 86400 });
  c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
  return c.req.method === 'GET' ? c.redirect(`${config.appUrl}/?reader=signed-in&publication=${encodeURIComponent(c.req.param('slug')!)}`, 303) : c.json({ reader: identity });
 }
 app.get('/public/:slug/reader/verify', verify); app.post('/public/:slug/reader/verify', verify);
 app.get('/public/:slug/reader/me', async c => { c.header('Cache-Control', 'no-store'); const reader = await publicReader(c, services); const { sessionId, ...profile } = reader; return c.json({ reader: profile }); });
 app.post('/public/:slug/reader/logout', async c => { assertReaderOrigin(c); const tenant = await resolvePublicTenant(services.store, c.req.param('slug')!); const raw = getCookie(c, COOKIE); if (raw) { const record = await services.store.get(tenant, 'reader_session', hash(raw)); if (record) await services.store.update(tenant, 'reader_session', record.id, { ...record.data, revoked: true }, record.version); } deleteCookie(c, COOKIE, { path: '/api/public', secure: config.production || config.appUrl.startsWith('https:'), sameSite: 'Lax' }); return c.json({ signedOut: true }); });
}
