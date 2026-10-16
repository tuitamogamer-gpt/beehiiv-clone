import { z } from 'zod';
import type { Api, Ctx, RecordData, Services, Store, Stored } from '../contracts.js';
import { config } from '../core/config.js';
import { ApiError, audit, flatten, hash, jsonBody, now, pagination, randomToken, requireRole, requireScope } from '../core/http.js';
import { rateLimit, requestIp, resolvePublicTenant } from '../core/security.js';
import { allRecords } from '../core/store.js';

const recordId = z.string().min(1).max(200);
const hexColor = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const httpsUrl = z.string().url().max(2000).refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }, 'Use an HTTPS URL without credentials.');
const originSchema = httpsUrl.refine(value => new URL(value).origin === value, 'Use an origin without a path or trailing slash.');
const utmValue = z.string().max(100).regex(/^[a-zA-Z0-9 ._~:/-]*$/);
const utmSchema = z.object({ source: utmValue.optional(), medium: utmValue.optional(), campaign: utmValue.optional() }).strict();
export const growthSignupFields = {
  formId: recordId.optional(),
  listIds: z.preprocess(value => typeof value === 'string' ? value.split(',').filter(Boolean) : Array.isArray(value) ? value.filter(Boolean) : value, z.array(recordId).max(20).optional()),
  referralCode: z.string().min(12).max(100).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  utm: utmSchema.optional(),
};
export type GrowthSignupInput = { formId?: string; listIds?: string[]; referralCode?: string; utm?: z.infer<typeof utmSchema> };
const listSchema = z.object({ name: z.string().trim().min(1).max(150), description: z.string().max(1000).default(''), public: z.boolean().default(true), active: z.boolean().default(true) }).strict();
const formSchema = z.object({
  name: z.string().trim().min(1).max(150), title: z.string().trim().min(1).max(200), description: z.string().max(1000).default(''),
  buttonText: z.string().trim().min(1).max(60).default('Subscribe'), successMessage: z.string().min(1).max(1000).default('Check your inbox to confirm your subscription.'),
  successRedirect: httpsUrl.nullable().default(null), layout: z.enum(['full', 'fixed', 'slim']).default('fixed'),
  colors: z.object({ background: hexColor.default('#ffffff'), text: hexColor.default('#17252a'), button: hexColor.default('#ef6b4a') }).strict().default({ background: '#ffffff', text: '#17252a', button: '#ef6b4a' }),
  font: z.enum(['Arial', 'Georgia', 'Verdana']).default('Arial'), listIds: z.array(recordId).max(20).default([]),
  allowedOrigins: z.array(originSchema).max(20).default([]),
}).strict();
const recommendationSchema = z.object({ name: z.string().trim().min(1).max(150), description: z.string().max(1000).default(''), url: httpsUrl, active: z.boolean().default(true) }).strict();
const milestoneSchema = z.object({ name: z.string().trim().min(1).max(150), description: z.string().max(1000).default(''), threshold: z.number().int().min(1).max(1_000_000), active: z.boolean().default(true) }).strict();
// PATCH fields deliberately have no defaults: Zod 4 applies nested defaults even
// through optional(), which would otherwise erase unrelated saved settings.
const patchVersion = z.number().int().positive().optional();
const listPatchSchema = z.object({ name: z.string().trim().min(1).max(150).optional(), description: z.string().max(1000).optional(), public: z.boolean().optional(), active: z.boolean().optional(), version: patchVersion }).strict();
const formPatchSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(), title: z.string().trim().min(1).max(200).optional(), description: z.string().max(1000).optional(),
  buttonText: z.string().trim().min(1).max(60).optional(), successMessage: z.string().min(1).max(1000).optional(), successRedirect: httpsUrl.nullable().optional(),
  layout: z.enum(['full', 'fixed', 'slim']).optional(), colors: z.object({ background: hexColor.optional(), text: hexColor.optional(), button: hexColor.optional() }).strict().optional(),
  font: z.enum(['Arial', 'Georgia', 'Verdana']).optional(), listIds: z.array(recordId).max(20).optional(), allowedOrigins: z.array(originSchema).max(20).optional(), version: patchVersion,
}).strict();
const recommendationPatchSchema = z.object({ name: z.string().trim().min(1).max(150).optional(), description: z.string().max(1000).optional(), url: httpsUrl.optional(), active: z.boolean().optional(), version: patchVersion }).strict();
const milestonePatchSchema = z.object({ name: z.string().trim().min(1).max(150).optional(), description: z.string().max(1000).optional(), threshold: z.number().int().min(1).max(1_000_000).optional(), active: z.boolean().optional(), version: patchVersion }).strict();
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
function authorize(c: Ctx, write = false) { const actor = requireRole(c, 'admin', 'member'); requireScope(c, write ? 'growth:write' : 'growth:read'); return actor; }
async function find(store: Store, tenantId: string, kind: string, id: string) { const row = await store.get(tenantId, kind, id); if (!row) throw new ApiError(404, 'not_found', 'Record not found.'); return row; }
async function checkLists(store: Store, tenantId: string, listIds: string[], publicOnly = false) {
  for (const listId of new Set(listIds)) { const list = await find(store, tenantId, 'newsletter_list', listId); if (!list.data.active || list.data.archivedAt || publicOnly && !list.data.public) throw new ApiError(422, 'list_unavailable', 'A selected newsletter list is unavailable.'); }
}
async function membership(services: Services, tx: Store, tenantId: string, listId: string, subscriber: Stored, status: 'subscribed' | 'pending' | 'unsubscribed', source: string) {
  const key = hash(`${listId}:${subscriber.id}`); await tx.lock(`list-member:${tenantId}:${key}`);
  const existing = await tx.get(tenantId, 'newsletter_membership', key);
  if (existing?.data.status === status) return existing;
  const data = { listId, subscriberId: subscriber.id, status, source, joinedAt: existing?.data.joinedAt || now(), changedAt: now() };
  const row = existing ? await tx.update(tenantId, 'newsletter_membership', key, data, existing.version) : await tx.insert(tenantId, 'newsletter_membership', data, key);
  if (status !== 'pending') await services.emit(tenantId, status === 'subscribed' ? 'newsletter_list.subscribed' : 'newsletter_list.unsubscribed', { listId, subscriberId: subscriber.id }, tx);
  return row;
}

/** Called only for a newly created subscriber, in the audience signup transaction. */
export async function recordGrowthSignup(services: Services, tx: Store, tenantId: string, subscriber: Stored, input: GrowthSignupInput): Promise<void> {
  const parsed = z.object(growthSignupFields).parse({ formId: input.formId, listIds: input.listIds, referralCode: input.referralCode, utm: input.utm });
  await tx.lock(`signup-attribution:${tenantId}:${subscriber.id}`);
  if (await tx.get(tenantId, 'signup_attribution', subscriber.id)) return;
  let listIds = [...new Set(parsed.listIds || [])];
  if (parsed.formId) {
    const form = await find(tx, tenantId, 'signup_form', parsed.formId);
    if (!form.data.live || form.data.archivedAt) throw new ApiError(404, 'form_unavailable', 'This signup form is unavailable.');
    if (parsed.listIds === undefined) listIds = form.data.live.listIds;
    if (listIds.some(listId => !form.data.live.listIds.includes(listId))) throw new ApiError(422, 'list_not_in_form', 'A selected list does not belong to this form.');
  }
  await checkLists(tx, tenantId, listIds, true);
  let referrerSubscriberId: string | null = null;
  if (parsed.referralCode) {
    const link = await tx.get(tenantId, 'referral_link', parsed.referralCode);
    if (link?.data.active && link.data.subscriberId !== subscriber.id) {
      const referrer = await tx.get(tenantId, 'subscriber', link.data.subscriberId);
      if (referrer?.data.status === 'Active' && referrer.data.email !== subscriber.data.email) referrerSubscriberId = referrer.id;
    }
  }
  await tx.insert(tenantId, 'signup_attribution', { subscriberId: subscriber.id, formId: parsed.formId || null, listIds, source: parsed.formId ? `form:${parsed.formId}` : subscriber.data.source, utm: parsed.utm || {}, referrerSubscriberId, referralCode: referrerSubscriberId ? parsed.referralCode : null, status: 'pending', createdAt: now() }, subscriber.id);
  for (const listId of listIds) await membership(services, tx, tenantId, listId, subscriber, subscriber.data.status === 'Active' ? 'subscribed' : 'pending', parsed.formId ? `form:${parsed.formId}` : 'signup');
  if (subscriber.data.status === 'Active') await confirmGrowthSignup(services, tx, tenantId, subscriber);
}

/** Confirmation credits one referral; retries cannot duplicate credits or earned rewards. */
export async function confirmGrowthSignup(services: Services, tx: Store, tenantId: string, subscriber: Stored): Promise<void> {
  await tx.lock(`signup-attribution:${tenantId}:${subscriber.id}`);
  const currentSubscriber = await tx.get(tenantId, 'subscriber', subscriber.id);
  if (!currentSubscriber || currentSubscriber.data.status !== 'Active') return;
  const attribution = await tx.get(tenantId, 'signup_attribution', subscriber.id);
  if (!attribution || attribution.data.status === 'confirmed') return;
  await tx.update(tenantId, 'signup_attribution', subscriber.id, { ...attribution.data, status: 'confirmed', confirmedAt: now() }, attribution.version);
  for (const listId of attribution.data.listIds || []) {
    const list = await tx.get(tenantId, 'newsletter_list', listId), member = await tx.get(tenantId, 'newsletter_membership', hash(`${listId}:${subscriber.id}`));
    if (list?.data.active && !list.data.archivedAt && member?.data.status === 'pending') await membership(services, tx, tenantId, listId, subscriber, 'subscribed', member.data.source);
  }
  const referrerId = attribution.data.referrerSubscriberId;
  if (!referrerId || referrerId === subscriber.id) return;
  const referralLink = attribution.data.referralCode ? await tx.get(tenantId, 'referral_link', attribution.data.referralCode) : null;
  if (!referralLink?.data.active || referralLink.data.subscriberId !== referrerId) return;
  const referrer = await tx.get(tenantId, 'subscriber', referrerId);
  if (referrer?.data.status !== 'Active') return;
  await tx.lock(`referral-progress:${tenantId}:${referrerId}`);
  if (await tx.get(tenantId, 'referral_credit', subscriber.id)) return;
  await tx.insert(tenantId, 'referral_credit', { subscriberId: subscriber.id, referrerSubscriberId: referrerId, confirmedAt: now(), source: 'active_signup' }, subscriber.id);
  const previous = await tx.get(tenantId, 'referral_progress', referrerId), count = Number(previous?.data.confirmedCount || 0) + 1;
  const progress = { subscriberId: referrerId, confirmedCount: count, updatedAt: now() };
  if (previous) await tx.update(tenantId, 'referral_progress', referrerId, progress, previous.version); else await tx.insert(tenantId, 'referral_progress', progress, referrerId);
  for (const milestone of await allRecords(tx, tenantId, 'referral_milestone', { active: true })) {
    const rewardId = hash(`${referrerId}:${milestone.id}`);
    if (count < milestone.data.threshold || await tx.get(tenantId, 'referral_reward', rewardId)) continue;
    await tx.insert(tenantId, 'referral_reward', { subscriberId: referrerId, milestoneId: milestone.id, milestoneName: milestone.data.name, threshold: milestone.data.threshold, status: 'earned', earnedAt: now(), fulfillment: 'manual' }, rewardId);
    await services.emit(tenantId, 'referral.milestone_earned', { subscriberId: referrerId, milestoneId: milestone.id, confirmedCount: count }, tx);
  }
  await services.emit(tenantId, 'referral.confirmed', { subscriberId: subscriber.id, referrerSubscriberId: referrerId }, tx);
}

export function classifyWebsiteAgent(userAgent: string) {
  const agent = userAgent.slice(0, 1000);
  return { botClassification: !agent ? 'unknown' : /bot|crawler|spider|headless|curl|wget|python|go-http-client|httpclient|facebookexternalhit|preview/i.test(agent) ? 'likely_bot' : 'not_identified_as_bot', device: /ipad|tablet/i.test(agent) ? 'tablet' : /mobile|iphone|android/i.test(agent) ? 'mobile' : 'desktop' };
}
function safePath(value: string) { try { const path = new URL(value, 'https://local.invalid').pathname; if (!path.startsWith('/') || path.length > 500) throw new Error(); return path; } catch { throw new ApiError(422, 'invalid_path', 'Provide a page path of at most 500 characters.'); } }
function referrerHost(value?: string) { try { const url = new URL(value || ''); return ['https:', 'http:'].includes(url.protocol) ? url.hostname.slice(0, 200) : ''; } catch { return ''; } }
async function recordView(services: Services, tenantId: string, input: { source: 'page_view' | 'page_request'; path: string; userAgent?: string; referrer?: string; eventId?: string; utm?: z.infer<typeof utmSchema> }) {
  const agent = classifyWebsiteAgent(input.userAgent || ''), path = safePath(input.path), referrer = referrerHost(input.referrer), day = now().slice(0, 10);
  const channel = input.utm?.medium || (referrer ? 'referral' : 'direct');
  const data = { source: input.source, path, referrerHost: referrer, channel, ...agent, utm: input.utm || {}, day, at: now(), classificationMethod: 'user_agent_heuristic' };
  const eventId = input.eventId ? hash(`${input.source}:${input.eventId}`) : undefined;
  return services.store.transaction(async tx => {
    if (eventId) { await tx.lock(`website-event:${tenantId}:${eventId}`); if (await tx.get(tenantId, 'website_event', eventId)) return false; }
    await tx.insert(tenantId, 'website_event', data, eventId);
    const dimensions = { day, source: input.source, path, referrerHost: referrer, channel, ...agent };
    const aggregateId = hash(JSON.stringify(dimensions)); await tx.lock(`website-daily:${tenantId}:${aggregateId}`);
    const existing = await tx.get(tenantId, 'website_daily', aggregateId);
    if (existing) await tx.update(tenantId, 'website_daily', aggregateId, { ...existing.data, views: existing.data.views + 1 }, existing.version);
    else await tx.insert(tenantId, 'website_daily', { ...dimensions, views: 1 }, aggregateId);
    return true;
  });
}
export async function recordWebsiteRequest(services: Services, tenantId: string, input: { path: string; referrer?: string; userAgent?: string }) { return recordView(services, tenantId, { ...input, source: 'page_request' }); }
async function trustedOrigin(store: Store, tenantId: string, origin: string | undefined) {
  const publication = (await store.list(tenantId, 'publication', { limit: 1 })).items[0];
  const allowed = new Set([new URL(config.appUrl).origin]);
  if (publication?.data.domain) { try { allowed.add(new URL(`https://${String(publication.data.domain).replace(/^https?:\/\//, '').replace(/\/$/, '')}`).origin); } catch { /* Invalid configuration cannot grant an origin. */ } }
  if (!origin || !allowed.has(origin)) throw new ApiError(403, 'invalid_origin', 'This website origin is not configured for the publication.');
  return origin;
}

export function registerGrowth(app: Api, services: Services): void {
  const { store } = services;
  app.get('/newsletter-lists', async c => { const p = authorize(c); const page = await store.list(p.tenantId, 'newsletter_list', pagination(c)); return c.json({ items: page.items.map(flatten), nextCursor: page.nextCursor }); });
  app.post('/newsletter-lists', async c => { const p = authorize(c, true); return c.json(flatten(await store.insert(p.tenantId, 'newsletter_list', await jsonBody(c, listSchema))), 201); });
  app.get('/newsletter-lists/:id', async c => { const p = authorize(c); return c.json(flatten(await find(store, p.tenantId, 'newsletter_list', c.req.param('id')))); });
  app.patch('/newsletter-lists/:id', async c => { const p = authorize(c, true), { version, ...patch } = await jsonBody(c, listPatchSchema); const row = await find(store, p.tenantId, 'newsletter_list', c.req.param('id')); return c.json(flatten(await store.update(p.tenantId, 'newsletter_list', row.id, { ...row.data, ...patch }, version ?? row.version))); });
  app.delete('/newsletter-lists/:id', async c => { const p = authorize(c, true), row = await find(store, p.tenantId, 'newsletter_list', c.req.param('id')); await store.update(p.tenantId, 'newsletter_list', row.id, { ...row.data, active: false, archivedAt: now() }, row.version); return c.body(null, 204); });
  app.get('/newsletter-lists/:id/members', async c => { const p = authorize(c); requireScope(c, 'subscribers:read'); await find(store, p.tenantId, 'newsletter_list', c.req.param('id')); const page = await store.list(p.tenantId, 'newsletter_membership', { ...pagination(c), filters: { listId: c.req.param('id') } }); return c.json({ items: page.items.map(flatten), nextCursor: page.nextCursor }); });
  app.post('/newsletter-lists/:id/members', async c => {
    const p = authorize(c, true); requireScope(c, 'subscribers:write'); const input = await jsonBody(c, z.object({ subscriberId: recordId, status: z.enum(['subscribed', 'unsubscribed']).default('subscribed') }).strict());
    const row = await store.transaction(async tx => { await checkLists(tx, p.tenantId, [c.req.param('id')]); const subscriber = await find(tx, p.tenantId, 'subscriber', input.subscriberId); if (input.status === 'subscribed' && subscriber.data.status !== 'Active') throw new ApiError(409, 'subscriber_inactive', 'Only active subscribers can join a list.'); return membership(services, tx, p.tenantId, c.req.param('id'), subscriber, input.status, 'workspace'); }); return c.json(flatten(row), 201);
  });
  app.delete('/newsletter-lists/:id/members/:subscriberId', async c => { const p = authorize(c, true); requireScope(c, 'subscribers:write'); await store.transaction(async tx => { await find(tx, p.tenantId, 'newsletter_list', c.req.param('id')); const subscriber = await find(tx, p.tenantId, 'subscriber', c.req.param('subscriberId')); await membership(services, tx, p.tenantId, c.req.param('id'), subscriber, 'unsubscribed', 'workspace'); }); return c.body(null, 204); });

  app.get('/signup-forms', async c => { const p = authorize(c), page = await store.list(p.tenantId, 'signup_form', pagination(c)); return c.json({ items: page.items.map(flatten), nextCursor: page.nextCursor }); });
  app.post('/signup-forms', async c => { const p = authorize(c, true), draft = await jsonBody(c, formSchema); await checkLists(store, p.tenantId, draft.listIds, true); return c.json(flatten(await store.insert(p.tenantId, 'signup_form', { draft, live: null, createdBy: p.userId })), 201); });
  app.get('/signup-forms/:id', async c => { const p = authorize(c); return c.json(flatten(await find(store, p.tenantId, 'signup_form', c.req.param('id')))); });
  app.patch('/signup-forms/:id', async c => { const p = authorize(c, true), { version, ...changes } = await jsonBody(c, formPatchSchema); const row = await find(store, p.tenantId, 'signup_form', c.req.param('id')), draft = formSchema.parse({ ...row.data.draft, ...changes, ...(changes.colors ? { colors: { ...row.data.draft.colors, ...changes.colors } } : {}) }); await checkLists(store, p.tenantId, draft.listIds, true); return c.json(flatten(await store.update(p.tenantId, 'signup_form', row.id, { ...row.data, draft }, version ?? row.version))); });
  app.post('/signup-forms/:id/publish', async c => { const p = authorize(c, true), row = await find(store, p.tenantId, 'signup_form', c.req.param('id')); await checkLists(store, p.tenantId, row.data.draft.listIds, true); const result = await store.update(p.tenantId, 'signup_form', row.id, { ...row.data, live: row.data.draft, publishedAt: now(), archivedAt: null }, row.version); await audit(services, p, 'signup_form.published', { formId: row.id }); return c.json(flatten(result)); });
  app.delete('/signup-forms/:id', async c => { const p = authorize(c, true), row = await find(store, p.tenantId, 'signup_form', c.req.param('id')); await store.update(p.tenantId, 'signup_form', row.id, { ...row.data, live: null, archivedAt: now() }, row.version); return c.body(null, 204); });
  app.get('/signup-forms/:id/embed', async c => { const p = authorize(c); const row = await find(store, p.tenantId, 'signup_form', c.req.param('id')), publication = (await store.list(p.tenantId, 'publication', { limit: 1 })).items[0]; if (!row.data.live || !publication?.data.slug) throw new ApiError(409, 'form_unpublished', 'Publish the form and configure a publication slug first.'); const url = `${config.appUrl}/api/public/${encodeURIComponent(publication.data.slug)}/forms/${encodeURIComponent(row.id)}`; return c.json({ url, html: `<iframe title="${escape(row.data.live.title)}" src="${escape(url)}" style="border:0;width:100%;min-height:420px" loading="lazy"></iframe>` }); });
  app.get('/public/:slug/forms/:id', async c => {
    const tenantId = await resolvePublicTenant(store, c.req.param('slug')); await rateLimit(services, `form-view:${tenantId}:${hash(requestIp(c.req.raw.headers))}`, 120, 60);
    const row = await find(store, tenantId, 'signup_form', c.req.param('id')); if (!row.data.live || row.data.archivedAt) throw new ApiError(404, 'form_unavailable', 'This form is unpublished.'); const form = formSchema.parse(row.data.live);
    const nonce = randomToken(18), action = `${config.appUrl}/api/public/${encodeURIComponent(c.req.param('slug'))}/subscribe`;
    const utm = utmSchema.safeParse({ source: c.req.query('utm_source'), medium: c.req.query('utm_medium'), campaign: c.req.query('utm_campaign') });
    const referral = growthSignupFields.referralCode.safeParse(c.req.query('referralCode'));
    const fields = { formId: row.id, source: `form:${row.id}`, startedAt: String(Date.now()), ...(utm.success ? Object.fromEntries(Object.entries(utm.data).filter(([, value]) => value !== undefined).map(([key, value]) => [`utm_${key}`, value])) : {}), ...(referral.success && referral.data ? { referralCode: referral.data } : {}) };
    const listOptions: string[] = [];
    for (const listId of form.listIds) { const list = await store.get(tenantId, 'newsletter_list', listId); if (list?.data.active && list.data.public && !list.data.archivedAt) listOptions.push(`<label class="choice"><input type="checkbox" name="listIds" value="${escape(listId)}" checked> ${escape(list.data.name)}</label>`); }
    const clientConfig = JSON.stringify({ message: form.successMessage, redirect: form.successRedirect }).replace(/</g, '\\u003c');
    c.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' ${new URL(config.appUrl).origin} https://challenges.cloudflare.com; form-action ${new URL(config.appUrl).origin}; base-uri 'none'; frame-ancestors 'self' ${form.allowedOrigins.length ? form.allowedOrigins.join(' ') : 'https:'}`);
    c.header('Cache-Control', 'no-store');
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(form.title)}</title><style>*{box-sizing:border-box}body{margin:0;padding:20px;background:${form.colors.background};color:${form.colors.text};font:16px/1.5 ${form.font},sans-serif}main{max-width:${form.layout === 'full' ? '100%' : '520px'};margin:auto}h1{font-size:24px}label{display:block;margin:10px 0}input[type=email],input[type=text]{width:100%;padding:12px;border:1px solid #aaa;border-radius:6px}button{background:${form.colors.button};color:#fff;border:0;border-radius:6px;padding:12px 20px;cursor:pointer}.honey{position:absolute;left:-10000px}.choice{font-size:14px}#message{white-space:pre-wrap}</style></head><body><main><h1>${escape(form.title)}</h1><p>${escape(form.description)}</p><form id="signup" method="post" action="${escape(action)}"><label>Name<input type="text" name="name" maxlength="200" autocomplete="given-name"></label><label>Email<input type="email" name="email" maxlength="254" autocomplete="email" required></label>${Object.entries(fields).map(([key, value]) => `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`).join('')}<input type="hidden" name="listIds" value="">${listOptions.join('')}<div class="honey" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div><label class="choice"><input type="checkbox" name="consent" value="true" required> I agree to receive these newsletters. I can unsubscribe at any time.</label>${config.turnstileSiteKey ? `<div class="cf-turnstile" data-sitekey="${escape(config.turnstileSiteKey)}"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ''}<button type="submit">${escape(form.buttonText)}</button></form><p id="message" role="status"></p></main><script nonce="${nonce}">const settings=${clientConfig};const form=document.getElementById('signup');form.elements.startedAt.value=Date.now();form.addEventListener('submit',async event=>{event.preventDefault();const message=document.getElementById('message');const button=form.querySelector('button');button.disabled=true;try{const response=await fetch(form.action,{method:'POST',body:new URLSearchParams(new FormData(form))});const result=await response.json();if(!response.ok)throw new Error(result.error?.message||result.message||'Unable to subscribe. Please try again.');if(settings.redirect){location.assign(settings.redirect);return}message.textContent=settings.message;form.hidden=true}catch(error){message.textContent=error.message;button.disabled=false}});</script></body></html>`);
  });

  for (const [path, kind, schema, patchSchema] of [['recommendations', 'recommendation', recommendationSchema, recommendationPatchSchema], ['referral-milestones', 'referral_milestone', milestoneSchema, milestonePatchSchema]] as const) {
    app.get(`/${path}`, async c => { const p = authorize(c), page = await store.list(p.tenantId, kind, pagination(c)); return c.json({ items: page.items.map(flatten), nextCursor: page.nextCursor }); });
    app.post(`/${path}`, async c => { const p = authorize(c, true), input = await jsonBody(c, schema); return c.json(flatten(await store.insert(p.tenantId, kind, input)), 201); });
    app.patch(`/${path}/:id`, async c => { const p = authorize(c, true), row = await find(store, p.tenantId, kind, c.req.param('id')); const { version, ...changes } = await jsonBody(c, patchSchema); return c.json(flatten(await store.update(p.tenantId, kind, row.id, { ...row.data, ...changes }, version ?? row.version))); });
    app.delete(`/${path}/:id`, async c => { const p = authorize(c, true), row = await find(store, p.tenantId, kind, c.req.param('id')); await store.update(p.tenantId, kind, row.id, { ...row.data, active: false, archivedAt: now() }, row.version); return c.body(null, 204); });
  }
  app.get('/public/:slug/recommendations', async c => { const tenantId = await resolvePublicTenant(store, c.req.param('slug')); await rateLimit(services, `recommendations:${tenantId}:${hash(requestIp(c.req.raw.headers))}`, 120, 60); const page = await store.list(tenantId, 'recommendation', { limit: 100, cursor: c.req.query('cursor'), filters: { active: true } }); return c.json({ items: page.items.map(row => ({ id: row.id, name: row.data.name, description: row.data.description, url: row.data.url })), network: 'publication_managed', nextCursor: page.nextCursor }); });
  app.post('/referral-links', async c => { const p = authorize(c, true); requireScope(c, 'subscribers:read'); const input = await jsonBody(c, z.object({ subscriberId: recordId }).strict()); const row = await store.transaction(async tx => { await tx.lock(`referral-link:${p.tenantId}:${input.subscriberId}`); const subscriber = await find(tx, p.tenantId, 'subscriber', input.subscriberId); if (subscriber.data.status !== 'Active') throw new ApiError(409, 'subscriber_inactive', 'Referral links require an active subscriber.'); const existing = (await tx.list(p.tenantId, 'referral_link', { filters: { subscriberId: subscriber.id, active: true }, limit: 1 })).items[0]; return existing || tx.insert(p.tenantId, 'referral_link', { subscriberId: subscriber.id, active: true, createdAt: now() }, randomToken(18)); }); return c.json({ ...flatten(row), referralCode: row.id }, 201); });
  app.get('/referral-links', async c => { const p = authorize(c); requireScope(c, 'subscribers:read'); const page = await store.list(p.tenantId, 'referral_link', pagination(c)); return c.json({ items: page.items.map(flatten), nextCursor: page.nextCursor }); });
  app.delete('/referral-links/:id', async c => { const p = authorize(c, true), row = await find(store, p.tenantId, 'referral_link', c.req.param('id')); await store.update(p.tenantId, 'referral_link', row.id, { ...row.data, active: false }, row.version); return c.body(null, 204); });
  app.get('/referral-rewards', async c => { const p = authorize(c); requireScope(c, 'subscribers:read'); const page = await store.list(p.tenantId, 'referral_reward', pagination(c)); return c.json({ items: page.items.map(flatten), nextCursor: page.nextCursor }); });
  app.post('/referral-rewards/:id/fulfill', async c => { const p = authorize(c, true), row = await find(store, p.tenantId, 'referral_reward', c.req.param('id')); if (row.data.status === 'fulfilled') return c.json(flatten(row)); const result = await store.update(p.tenantId, 'referral_reward', row.id, { ...row.data, status: 'fulfilled', fulfilledAt: now(), fulfilledBy: p.userId }, row.version); await audit(services, p, 'referral_reward.fulfilled', { rewardId: row.id }); return c.json(flatten(result)); });
  app.get('/growth/attribution', async c => { const p = authorize(c); requireScope(c, 'subscribers:read'); const page = await store.list(p.tenantId, 'signup_attribution', pagination(c)); return c.json({ items: page.items.map(flatten), nextCursor: page.nextCursor }); });
  app.get('/growth/referrals', async c => { const p = authorize(c); requireScope(c, 'subscribers:read'); const page = await store.list(p.tenantId, 'referral_progress', pagination(c)); return c.json({ items: page.items.map(flatten), nextCursor: page.nextCursor, qualification: 'active_signup', rewards: 'manual_fulfillment', fraudVerification: 'not_integrated' }); });

  app.options('/public/:slug/pageviews', async c => { const tenantId = await resolvePublicTenant(store, c.req.param('slug')), origin = await trustedOrigin(store, tenantId, c.req.header('origin')); c.header('Access-Control-Allow-Origin', origin); c.header('Vary', 'Origin'); c.header('Access-Control-Allow-Methods', 'POST, OPTIONS'); c.header('Access-Control-Allow-Headers', 'Content-Type'); return c.body(null, 204); });
  app.post('/public/:slug/pageviews', async c => {
    const tenantId = await resolvePublicTenant(store, c.req.param('slug')), origin = await trustedOrigin(store, tenantId, c.req.header('origin')); c.header('Access-Control-Allow-Origin', origin); c.header('Vary', 'Origin'); await rateLimit(services, `pageviews:${tenantId}:${hash(requestIp(c.req.raw.headers))}`, 120, 60);
    const input = await jsonBody(c, z.object({ eventId: z.string().uuid(), path: z.string().min(1).max(2000).refine(value => value.startsWith('/') && !value.startsWith('//'), 'Use an internal page path.'), referrer: z.string().max(2000).optional(), utm: utmSchema.optional() }).strict());
    await recordView(services, tenantId, { ...input, source: 'page_view', userAgent: c.req.header('user-agent') }); return c.body(null, 202);
  });
  app.get('/analytics/website', async c => {
    const p = authorize(c), today = now().slice(0, 10); const query = z.object({ from: z.string().date().default(today), to: z.string().date().default(today), source: z.enum(['page_view', 'page_request']).default('page_view'), path: z.string().max(500).optional(), channel: z.string().max(100).optional(), device: z.enum(['desktop', 'mobile', 'tablet']).optional(), botClassification: z.enum(['likely_bot', 'not_identified_as_bot', 'unknown']).optional(), referrerHost: z.string().max(200).optional() }).safeParse(c.req.query());
    if (!query.success) throw new ApiError(422, 'invalid_report_filters', 'Check the date range and report filters.'); const { from, to, ...filters } = query.data, start = Date.parse(from), end = Date.parse(to);
    if (end < start || end - start > 90 * 86_400_000) throw new ApiError(422, 'invalid_date_range', 'Choose a date range of at most 91 days.');
    const totals = { views: 0, likelyBotViews: 0, unidentifiedAsBotViews: 0, unknownViews: 0 }, byDay: Record<string, number> = {}, byPath: Record<string, number> = {}, byChannel: Record<string, number> = {};
    for (let time = start; time <= end; time += 86_400_000) { const day = new Date(time).toISOString().slice(0, 10); const cleanFilters: Record<string, string> = { day }; for (const [key, value] of Object.entries(filters)) if (value !== undefined) cleanFilters[key] = value; const rows = await allRecords(store, p.tenantId, 'website_daily', cleanFilters, 20_000); for (const row of rows) { const count = row.data.views; totals.views += count; if (row.data.botClassification === 'likely_bot') totals.likelyBotViews += count; else if (row.data.botClassification === 'not_identified_as_bot') totals.unidentifiedAsBotViews += count; else totals.unknownViews += count; byDay[day] = (byDay[day] || 0) + count; byPath[row.data.path] = (byPath[row.data.path] || 0) + count; byChannel[row.data.channel] = (byChannel[row.data.channel] || 0) + count; } }
    return c.json({ from, to, source: filters.source, ...totals, byDay, byPath, byChannel, classificationMethod: 'user_agent_heuristic', uniqueVisitors: null, note: 'User agents can be spoofed. Counts are recorded events, not verified people. Server page requests and client page views are separate series.' });
  });
}
