import { z } from 'zod';
import sanitizeHtml from 'sanitize-html';
import type { Api, Ctx, EmailMessage, RecordData, Services, Store, Stored } from '../contracts.js';
import { ApiError, audit, hash, id, jsonBody, now, principal, requireRole, requireScope } from '../core/http.js';
import { safeFetch } from '../core/network.js';
import { emailSendEligibility } from './audience.js';
import { assertSenderReady, createUnsubscribeLink, registerProviderMessage } from './delivery.js';

const nodeId = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
const nextId = nodeId.nullable().optional();
const eventSchema = z.enum(['manual', 'subscriber.created', 'subscriber.confirmed', 'subscriber.updated', 'purchase.completed']);
const nodeBase = { id: nodeId, label: z.string().trim().max(200).optional() };
const conditionSchema = z.object({
  field: z.enum(['source', 'tier', 'status', 'tags', 'customField']),
  customField: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  operator: z.enum(['equals', 'not_equals', 'contains', 'exists']),
  value: z.union([z.string().max(1000), z.number().finite(), z.boolean()]).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.field === 'customField' && (!value.customField || ['__proto__', 'constructor', 'prototype'].includes(value.customField))) {
    ctx.addIssue({ code: 'custom', message: 'A valid custom field name is required.', path: ['customField'] });
  }
  if (value.operator !== 'exists' && value.value === undefined) ctx.addIssue({ code: 'custom', message: 'This condition requires a value.', path: ['value'] });
});
const httpsUrl = z.string().url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}, 'Use an HTTPS URL without credentials.');

export const automationNodeSchema = z.discriminatedUnion('type', [
  z.object({ ...nodeBase, type: z.literal('trigger'), event: eventSchema, source: z.string().max(200).optional(), tier: z.enum(['Free', 'Premium']).optional(), tag: z.string().max(100).optional(), next: nextId }).strict(),
  z.object({ ...nodeBase, type: z.literal('delay'), seconds: z.number().int().min(1).max(31_536_000), next: nextId }).strict(),
  z.object({ ...nodeBase, type: z.literal('email'), subject: z.string().trim().min(1).max(200).refine(value => !/[\r\n]/.test(value), 'Subject must be a single line.'), html: z.string().min(1).max(300_000), next: nextId }).strict(),
  z.object({ ...nodeBase, type: z.literal('condition'), condition: conditionSchema, yes: nextId, no: nextId }).strict(),
  z.object({ ...nodeBase, type: z.literal('webhook'), url: httpsUrl, payload: z.record(z.string(), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])).optional(), next: nextId }).strict(),
]);
export type AutomationNode = z.infer<typeof automationNodeSchema>;

/** Each journey follows one path; conditions choose exactly one outgoing edge. */
export const automationGraphSchema = z.array(automationNodeSchema).max(100).superRefine((nodes, ctx) => {
  if (nodes.length === 0) return; // An empty draft is allowed, but cannot be published.
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length) ctx.addIssue({ code: 'custom', message: 'Node IDs must be unique.' });
  const triggers = nodes.filter(node => node.type === 'trigger');
  if (triggers.length !== 1) ctx.addIssue({ code: 'custom', message: 'Exactly one trigger is required.' });
  const edges = (node: AutomationNode) => (node.type === 'condition' ? [node.yes, node.no] : [node.next]).filter((value): value is string => !!value);
  for (const node of nodes) for (const target of edges(node)) {
    if (!byId.has(target)) ctx.addIssue({ code: 'custom', message: `Node ${node.id} references missing node ${target}.` });
    if (byId.get(target)?.type === 'trigger') ctx.addIssue({ code: 'custom', message: 'The trigger cannot have incoming edges.' });
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let cycle = false;
  function visit(key: string) {
    if (visiting.has(key)) { cycle = true; return; }
    if (visited.has(key)) return;
    const node = byId.get(key);
    if (!node) return;
    visiting.add(key);
    for (const target of edges(node)) visit(target);
    visiting.delete(key);
    visited.add(key);
  }
  if (triggers[0]) visit(triggers[0].id);
  if (visited.size !== byId.size) ctx.addIssue({ code: 'custom', message: 'Every node must be reachable from the trigger.' });
  for (const node of nodes) visit(node.id);
  if (cycle) ctx.addIssue({ code: 'custom', message: 'Automation workflows cannot contain cycles.' });
});

const draftFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).default(''),
  steps: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  nodes: automationGraphSchema.default([]),
};
const createSchema = z.object(draftFields).strict();
const updateSchema = z.object({
  name: draftFields.name.optional(), description: z.string().trim().max(2000).optional(),
  steps: z.array(z.string().trim().min(1).max(200)).max(100).optional(), nodes: automationGraphSchema.optional(),
  expectedVersion: z.number().int().positive().optional(),
}).strict();
const versionSchema = z.object({ expectedVersion: z.number().int().positive().optional() }).strict();
type AutomationData = RecordData & {
  name: string; description: string; steps: string[]; nodes: AutomationNode[];
  active: boolean; enrolled: number; liveRevision: number;
  live: { name: string; description: string; nodes: AutomationNode[]; publishedAt: string } | null;
};
type JourneyData = RecordData & {
  automationId: string; subscriberId: string; revision: number; nodes: AutomationNode[];
  status: 'queued' | 'running' | 'waiting' | 'retrying' | 'paused' | 'completed' | 'cancelled' | 'failed';
  currentNodeId: string | null; startedAt: string; nextRunAt?: string | null; completedAt?: string;
};
const terminal = new Set(['completed', 'cancelled', 'failed']);
const output = (record: Stored) => ({ id: record.id, ...record.data, version: record.version, createdAt: record.createdAt, updatedAt: record.updatedAt });
function authorize(c: Ctx, scope: 'read' | 'write' | 'publish') {
  const actor = principal(c);
  requireScope(c, `automations:${scope === 'publish' ? 'write' : scope}`);
  if (scope === 'publish') requireRole(c, 'admin', 'member');
  return actor;
}
function pageOptions(c: Ctx) {
  const parsed = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(2000).optional() }).safeParse(c.req.query());
  if (!parsed.success) throw new ApiError(400, 'invalid_query', 'Invalid pagination parameters.');
  return parsed.data;
}
async function getAutomation(store: Store, tenantId: string, automationId: string) {
  const record = await store.get<AutomationData>(tenantId, 'automation', automationId);
  if (!record) throw new ApiError(404, 'not_found', 'Automation not found.');
  return record;
}
function versionCheck(record: Stored, expectedVersion?: number) {
  if (expectedVersion !== undefined && expectedVersion !== record.version) throw new ApiError(409, 'conflict', 'Automation was changed by another editor. Reload before saving.');
}
function checkedGraph(nodes: AutomationNode[]) {
  const result = automationGraphSchema.safeParse(nodes);
  if (!result.success || !nodes.length) throw new ApiError(422, 'invalid_workflow', 'Configure a connected, acyclic workflow with one trigger before publishing.');
  return result.data;
}
function conditionMatches(condition: z.infer<typeof conditionSchema>, subscriber: RecordData) {
  const actual = condition.field === 'customField' ? subscriber.customFields?.[condition.customField!] : subscriber[condition.field];
  if (condition.operator === 'exists') return actual !== undefined && actual !== null && actual !== '';
  if (condition.operator === 'equals') return actual === condition.value;
  if (condition.operator === 'not_equals') return actual !== condition.value;
  return Array.isArray(actual) ? actual.includes(condition.value) : typeof actual === 'string' && actual.includes(String(condition.value));
}
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
function personalize(value: string, subscriber: RecordData, html: boolean) {
  return value.replace(/\{\{\s*(name|email|first_name)\s*\}\}/g, (_, key: string) => {
    const replacement = key === 'first_name' ? String(subscriber.name || '').split(/\s+/)[0] : subscriber[key];
    return html ? escapeHtml(replacement) : String(replacement ?? '').replace(/[\r\n]/g, ' ');
  });
}
function emailHtml(html: string, subscriber: RecordData, unsubscribeUrl: string) {
  const content = sanitizeHtml(personalize(html, subscriber, true), {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img'],
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, '*': ['style', 'align'], img: ['src', 'alt', 'width', 'height'], table: ['width', 'cellspacing', 'cellpadding', 'border', 'role', 'style'], td: ['colspan', 'rowspan', 'width', 'valign', 'style'] },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowedStyles: { '*': { color: [/^#[0-9a-f]{3,8}$/i, /^rgb\([\d\s,]+\)$/i], 'background-color': [/^#[0-9a-f]{3,8}$/i], 'font-size': [/^\d+(?:px|pt|em|%)$/], 'text-align': [/^(left|right|center|justify)$/], 'font-weight': [/^(normal|bold|[1-9]00)$/], padding: [/^[\d\s.px%em]+$/], 'line-height': [/^[\d.]+(?:px|em|%)?$/] } },
  });
  return '<!doctype html><html><body><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td><table role="presentation" width="600" align="center" cellspacing="0" cellpadding="0"><tr><td>' + content + '<p style="font-size:12px"><a href="' + escapeHtml(unsubscribeUrl) + '">Unsubscribe</a></p></td></tr></table></td></tr></table></body></html>';
}

/** Safe to call inside another module's transaction by passing its Store. */
export async function enrollAutomation(services: Services, tenantId: string, automationId: string, subscriberId: string, idempotencyKey: string, store?: Store): Promise<Stored<JourneyData>> {
  if (!idempotencyKey || idempotencyKey.length > 200) throw new ApiError(400, 'invalid_idempotency_key', 'An idempotency key of at most 200 characters is required.');
  const journeyId = hash(`automation:${automationId}:${subscriberId}:${idempotencyKey}`);
  const run = async (tx: Store) => {
    await tx.lock(`automation-enroll:${tenantId}:${automationId}`);
    const previous = await tx.get<JourneyData>(tenantId, 'automation_journey', journeyId);
    if (previous) return previous;
    const automation = await getAutomation(tx, tenantId, automationId);
    if (!automation.data.active || !automation.data.live) throw new ApiError(409, 'automation_inactive', 'Publish and activate the automation before enrolling subscribers.');
    const subscriber = await tx.get(tenantId, 'subscriber', subscriberId);
    if (!subscriber) throw new ApiError(404, 'subscriber_not_found', 'Subscriber not found.');
    if (subscriber.data.status !== 'Active') throw new ApiError(409, 'subscriber_inactive', 'Only active subscribers can enter an automation.');
    const nodes = checkedGraph(automation.data.live.nodes);
    const trigger = nodes.find(node => node.type === 'trigger')!;
    const journey = await tx.insert<JourneyData>(tenantId, 'automation_journey', { automationId, subscriberId, revision: automation.data.liveRevision, nodes, status: 'queued', currentNodeId: trigger.id, startedAt: now() }, journeyId);
    await tx.update(tenantId, 'automation', automationId, { ...automation.data, enrolled: automation.data.enrolled + 1 }, automation.version);
    await services.enqueue({ type: 'automation.node', tenantId, payload: { journeyId, nodeId: trigger.id }, idempotencyKey: `automation:${journeyId}:${trigger.id}`, maxAttempts: 128 }, tx);
    await services.emit(tenantId, 'automation.started', { automationId, subscriberId, journeyId, revision: automation.data.liveRevision }, tx);
    return journey;
  };
  return store ? run(store) : services.store.transaction(run);
}

/** Subscriber/product modules enqueue this in the same transaction as the source event. */
export async function triggerAutomations(services: Services, tenantId: string, event: Exclude<z.infer<typeof eventSchema>, 'manual'>, subscriberId: string, eventId: string, store?: Store) {
  return services.enqueue({ type: 'automation.trigger', tenantId, payload: { event, subscriberId, eventId }, idempotencyKey: `automation-trigger:${event}:${eventId}:${subscriberId}`, maxAttempts: 20 }, store);
}

async function runNode(services: Services, job: Stored, store: Store) {
  const { journeyId, nodeId: currentNodeId } = z.object({ journeyId: z.string().min(1), nodeId }).parse(job.data.payload);
  const tenantId = job.tenantId;
  const executionId = hash(`${journeyId}:${currentNodeId}`);
  const claimId = id();
  const claim = await store.transaction(async tx => {
    await tx.lock(`automation-journey:${tenantId}:${journeyId}`);
    const journey = await tx.get<JourneyData>(tenantId, 'automation_journey', journeyId);
    if (!journey || terminal.has(journey.data.status) || journey.data.currentNodeId !== currentNodeId) return null;
    const automation = await tx.get<AutomationData>(tenantId, 'automation', journey.data.automationId);
    if (!automation || !automation.data.active) {
      await tx.update(tenantId, 'automation_journey', journeyId, { ...journey.data, status: 'paused' }, journey.version);
      return null;
    }
    if (journey.data.nextRunAt && Date.parse(journey.data.nextRunAt) > Date.now()) throw new ApiError(503, 'journey_not_due', 'Journey delay has not elapsed.');
    const subscriber = await tx.get(tenantId, 'subscriber', journey.data.subscriberId);
    if (!subscriber || subscriber.data.status !== 'Active') {
      await tx.update(tenantId, 'automation_journey', journeyId, { ...journey.data, status: 'cancelled', reason: 'subscriber_inactive', completedAt: now() }, journey.version);
      return null;
    }
    const node = journey.data.nodes.find(item => item.id === currentNodeId);
    if (!node) throw new ApiError(422, 'invalid_workflow', 'Journey node is missing.');
    const existing = await tx.get(tenantId, 'automation_execution', executionId);
    if (existing?.data.status === 'completed' || existing?.data.status === 'skipped') return null;
    if (existing?.data.status === 'running' && Date.parse(existing.data.leaseUntil) > Date.now()) throw new ApiError(503, 'node_busy', 'This node is already executing.');
    const data = { ...existing?.data, journeyId, automationId: journey.data.automationId, subscriberId: journey.data.subscriberId, nodeId: currentNodeId, type: node.type, status: 'running', attempts: (existing?.data.attempts || 0) + 1, claimId, leaseUntil: new Date(Date.now() + 60_000).toISOString(), startedAt: existing?.data.startedAt || now(), lastAttemptAt: now() };
    if (existing) await tx.update(tenantId, 'automation_execution', executionId, data, existing.version);
    else await tx.insert(tenantId, 'automation_execution', data, executionId);
    await tx.update(tenantId, 'automation_journey', journeyId, { ...journey.data, status: 'running', nextRunAt: null }, journey.version);
    return { journey, node, subscriber, attempts: data.attempts };
  });
  if (!claim) return;
  const { journey, node, subscriber } = claim;
  let providerMessageId: string | undefined;
  let skipReason: string | undefined;
  let next = node.type === 'condition' ? (conditionMatches(node.condition, subscriber.data) ? node.yes : node.no) : node.next;
  try {
    if (node.type === 'email') {
      const eligibility = await emailSendEligibility(store, tenantId, subscriber.id);
      if (!eligibility.eligible) { skipReason = eligibility.reason || 'suppressed'; next = null; }
      else {
        const { sender } = await assertSenderReady(store, tenantId);
        const unsubscribeUrl = await createUnsubscribeLink(store, tenantId, subscriber.id);
        const current = eligibility.subscriber?.data || subscriber.data;
        const prepared: EmailMessage = {
          to: current.email, from: sender, subject: personalize(node.subject, current, false), html: emailHtml(node.html, current, unsubscribeUrl),
          headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'Feedback-ID': `${journey.data.automationId}:${tenantId}:automation:publisher` },
          tags: [{ name: 'publication_id', value: tenantId }, { name: 'automation_id', value: journey.data.automationId }, { name: 'journey_id', value: journeyId }, { name: 'node_id', value: currentNodeId }, { name: 'subscriber_id', value: subscriber.id }],
          idempotencyKey: `automation:${journeyId}:${currentNodeId}`,
        };
        // Persist the exact provider request before crossing the external-send boundary.
        // An ambiguous provider response must retry with identical body and key.
        const intent = await store.transaction(async tx => {
          await tx.lock(`automation-journey:${tenantId}:${journeyId}`);
          const execution = await tx.get(tenantId, 'automation_execution', executionId);
          const currentJourney = await tx.get<JourneyData>(tenantId, 'automation_journey', journeyId);
          if (!execution || execution.data.claimId !== claimId || !currentJourney || terminal.has(currentJourney.data.status)) return null;
          if (execution.data.emailIntent) {
            // Resend deduplicates requests for 24 hours. A lost acknowledgement must
            // be reconciled before that window expires instead of risking a second send.
            if (Date.now() - Date.parse(execution.data.emailIntentAt || execution.data.startedAt) >= 86_340_000) throw new ApiError(409, 'provider_acceptance_unknown', 'Delivery acknowledgement remains unknown. Reconcile with the provider before retrying.');
            return execution.data.emailIntent as EmailMessage;
          }
          await tx.update(tenantId, 'automation_execution', executionId, { ...execution.data, emailIntent: prepared, emailIntentAt: now() }, execution.version);
          return prepared;
        });
        if (!intent) return;
        if (intent.to !== current.email) throw new ApiError(409, 'subscriber_email_changed', 'Subscriber email changed during a delivery retry.');
        if (intent.from !== sender) throw new ApiError(409, 'sender_changed', 'Sender changed during a delivery retry.');
        const lastCheck = await emailSendEligibility(store, tenantId, subscriber.id);
        if (!lastCheck.eligible) { skipReason = lastCheck.reason || 'suppressed'; next = null; }
        else if (lastCheck.subscriber?.data.email !== intent.to) throw new ApiError(409, 'subscriber_email_changed', 'Subscriber email changed before delivery.');
        else {
          const message = await services.sendEmail(intent);
          providerMessageId = message.id;
        }
      }
    } else if (node.type === 'webhook') {
      const response = await safeFetch(node.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `automation:${journeyId}:${currentNodeId}` },
        body: JSON.stringify({ event: 'automation.webhook', version: 1, automationId: journey.data.automationId, journeyId, nodeId: currentNodeId, subscriber: { id: subscriber.id, email: subscriber.data.email, name: subscriber.data.name, tags: subscriber.data.tags, customFields: subscriber.data.customFields }, data: node.payload || {} }),
      });
      if (!response.ok) throw new ApiError(502, 'webhook_delivery_failed', `Webhook returned HTTP ${response.status}.`);
      await response.body?.cancel();
    }
    await store.transaction(async tx => {
      await tx.lock(`automation-journey:${tenantId}:${journeyId}`);
      const current = await tx.get<JourneyData>(tenantId, 'automation_journey', journeyId);
      const execution = await tx.get(tenantId, 'automation_execution', executionId);
      if (!current || !execution || execution.data.claimId !== claimId) return;
      if (providerMessageId) await registerProviderMessage(tx, tenantId, providerMessageId, { subscriberId: subscriber.id, automationId: journey.data.automationId, journeyId, nodeId: currentNodeId });
      await tx.update(tenantId, 'automation_execution', executionId, { ...execution.data, status: skipReason ? 'skipped' : 'completed', completedAt: now(), leaseUntil: null, ...(providerMessageId ? { providerMessageId } : {}), ...(skipReason ? { reason: skipReason } : {}) }, execution.version);
      if (terminal.has(current.data.status)) return;
      const runAt = node.type === 'delay' && next ? new Date(Date.now() + node.seconds * 1000).toISOString() : undefined;
      const status = skipReason ? 'cancelled' : !next ? 'completed' : runAt ? 'waiting' : 'queued';
      await tx.update(tenantId, 'automation_journey', journeyId, { ...current.data, status, currentNodeId: next || null, nextRunAt: runAt || null, ...(!next ? { completedAt: now() } : {}), ...(skipReason ? { reason: skipReason } : {}) }, current.version);
      if (next) await services.enqueue({ type: 'automation.node', tenantId, payload: { journeyId, nodeId: next }, idempotencyKey: `automation:${journeyId}:${next}`, ...(runAt ? { runAt } : {}), maxAttempts: 128 }, tx);
      else await services.emit(tenantId, skipReason ? 'automation.cancelled' : 'automation.completed', { automationId: journey.data.automationId, subscriberId: subscriber.id, journeyId, ...(skipReason ? { reason: skipReason } : {}) }, tx);
    });
  } catch (error) {
    const permanent = error instanceof ApiError && [400, 401, 403, 404, 409, 410, 422].includes(error.status);
    const exhausted = permanent || claim.attempts >= 128 || Number(job.data.attempts || 0) >= Number(job.data.maxAttempts || 128);
    await store.transaction(async tx => {
      await tx.lock(`automation-journey:${tenantId}:${journeyId}`);
      const execution = await tx.get(tenantId, 'automation_execution', executionId);
      const current = await tx.get<JourneyData>(tenantId, 'automation_journey', journeyId);
      if (execution?.data.claimId === claimId) await tx.update(tenantId, 'automation_execution', executionId, { ...execution.data, status: exhausted ? 'failed' : 'retrying', leaseUntil: null, lastError: error instanceof ApiError ? error.code : 'delivery_failed', failedAt: now() }, execution.version);
      if (current && !terminal.has(current.data.status)) await tx.update(tenantId, 'automation_journey', journeyId, { ...current.data, status: exhausted ? 'failed' : 'retrying', ...(exhausted ? { completedAt: now() } : {}) }, current.version);
    });
    throw error;
  }
}

export function registerAutomations(app: Api, services: Services): void {
  services.registerJob('automation.node', (job, store) => runNode(services, job, store));
  services.registerJob('automation.trigger', async (job, store) => {
    const payload = z.object({ event: eventSchema, subscriberId: z.string(), eventId: z.string(), cursor: z.string().optional() }).parse(job.data.payload);
    const subscriber = await store.get(job.tenantId, 'subscriber', payload.subscriberId);
    if (!subscriber || subscriber.data.status !== 'Active') return;
    const page = await store.list<AutomationData>(job.tenantId, 'automation', { filters: { active: true }, limit: 100, cursor: payload.cursor });
    for (const automation of page.items) {
      const trigger = automation.data.live?.nodes.find(node => node.type === 'trigger');
      if (!trigger || trigger.type !== 'trigger' || trigger.event !== payload.event || (trigger.source && trigger.source !== subscriber.data.source) || (trigger.tier && trigger.tier !== subscriber.data.tier) || (trigger.tag && !subscriber.data.tags?.includes(trigger.tag))) continue;
      try { await enrollAutomation(services, job.tenantId, automation.id, subscriber.id, `event:${hash(`${payload.event}:${payload.eventId}`)}`); }
      catch (error) { if (!(error instanceof ApiError) || !['automation_inactive', 'subscriber_inactive', 'subscriber_not_found'].includes(error.code)) throw error; }
    }
    if (page.nextCursor) await services.enqueue({ type: 'automation.trigger', tenantId: job.tenantId, payload: { ...payload, cursor: page.nextCursor }, idempotencyKey: `automation-trigger:${hash(`${payload.event}:${payload.eventId}:${payload.subscriberId}:${page.nextCursor}`)}`, maxAttempts: 20 });
  });
  services.registerJob('automation.resume', async (job, store) => {
    const { automationId, token } = z.object({ automationId: z.string(), token: z.string() }).parse(job.data.payload);
    await store.transaction(async tx => {
      await tx.lock(`automation-resume:${job.tenantId}:${automationId}`);
      const automation = await getAutomation(tx, job.tenantId, automationId);
      if (!automation.data.active) return;
      const page = await tx.list<JourneyData>(job.tenantId, 'automation_journey', { filters: { automationId, status: 'paused' }, limit: 100 });
      for (const journey of page.items) {
        if (!journey.data.currentNodeId) continue;
        await tx.update(job.tenantId, 'automation_journey', journey.id, { ...journey.data, status: journey.data.nextRunAt ? 'waiting' : 'queued' }, journey.version);
        await services.enqueue({ type: 'automation.node', tenantId: job.tenantId, payload: { journeyId: journey.id, nodeId: journey.data.currentNodeId }, idempotencyKey: `automation-resume:${token}:${journey.id}`, runAt: journey.data.nextRunAt || undefined, maxAttempts: 128 }, tx);
      }
      if (page.nextCursor) await services.enqueue({ type: 'automation.resume', tenantId: job.tenantId, payload: { automationId, token }, idempotencyKey: `automation-resume-page:${token}:${page.items.at(-1)!.id}`, maxAttempts: 20 }, tx);
    });
  });

  app.get('/automations', async c => {
    const actor = authorize(c, 'read');
    const page = await services.store.list(actor.tenantId, 'automation', pageOptions(c));
    return c.json({ items: page.items.map(output), nextCursor: page.nextCursor });
  });
  app.post('/automations', async c => {
    const actor = authorize(c, 'write');
    const data = await jsonBody(c, createSchema);
    const record = await services.store.insert<AutomationData>(actor.tenantId, 'automation', { ...data, active: false, enrolled: 0, liveRevision: 0, live: null });
    await audit(services, actor, 'automation.created', { automationId: record.id });
    return c.json(output(record), 201);
  });
  app.get('/automations/:id', async c => {
    const actor = authorize(c, 'read');
    return c.json(output(await getAutomation(services.store, actor.tenantId, c.req.param('id'))));
  });
  const update = async (c: Ctx) => {
    const actor = authorize(c, 'write');
    const { expectedVersion, ...changes } = await jsonBody(c, updateSchema);
    const record = await services.store.transaction(async tx => {
      await tx.lock(`automation-edit:${actor.tenantId}:${c.req.param('id')}`);
      const automation = await getAutomation(tx, actor.tenantId, c.req.param('id')!);
      versionCheck(automation, expectedVersion);
      return tx.update(actor.tenantId, 'automation', automation.id, { ...automation.data, ...changes }, automation.version);
    });
    return c.json(output(record));
  };
  app.patch('/automations/:id', update);
  app.put('/automations/:id', update);
  app.post('/automations/:id/publish', async c => {
    const actor = authorize(c, 'publish');
    const input = await jsonBody(c, versionSchema);
    const record = await services.store.transaction(async tx => {
      await tx.lock(`automation-edit:${actor.tenantId}:${c.req.param('id')}`);
      const automation = await getAutomation(tx, actor.tenantId, c.req.param('id'));
      versionCheck(automation, input.expectedVersion);
      const nodes = checkedGraph(automation.data.nodes);
      if (nodes.some(node => node.type === 'email')) await assertSenderReady(tx, actor.tenantId);
      const updated = await tx.update(actor.tenantId, 'automation', automation.id, { ...automation.data, active: true, liveRevision: automation.data.liveRevision + 1, live: { name: automation.data.name, description: automation.data.description, nodes, publishedAt: now() } }, automation.version);
      await services.enqueue({ type: 'automation.resume', tenantId: actor.tenantId, payload: { automationId: updated.id, token: String(updated.version) }, idempotencyKey: `automation-resume:${updated.id}:${updated.version}`, maxAttempts: 20 }, tx);
      return updated;
    });
    await audit(services, actor, 'automation.published', { automationId: record.id, revision: record.data.liveRevision });
    return c.json(output(record));
  });
  app.post('/automations/:id/status', async c => {
    const actor = authorize(c, 'publish');
    const input = await jsonBody(c, z.object({ active: z.boolean(), expectedVersion: z.number().int().positive().optional() }).strict());
    const record = await services.store.transaction(async tx => {
      await tx.lock(`automation-edit:${actor.tenantId}:${c.req.param('id')}`);
      const automation = await getAutomation(tx, actor.tenantId, c.req.param('id'));
      versionCheck(automation, input.expectedVersion);
      if (input.active && !automation.data.live) throw new ApiError(409, 'unpublished_automation', 'Publish a workflow before activating it.');
      const updated = await tx.update(actor.tenantId, 'automation', automation.id, { ...automation.data, active: input.active }, automation.version);
      if (input.active) await services.enqueue({ type: 'automation.resume', tenantId: actor.tenantId, payload: { automationId: automation.id, token: String(updated.version) }, idempotencyKey: `automation-resume:${automation.id}:${updated.version}`, maxAttempts: 20 }, tx);
      return updated;
    });
    return c.json(output(record));
  });
  app.delete('/automations/:id', async c => {
    const actor = authorize(c, 'publish');
    await services.store.transaction(async tx => {
      await tx.lock(`automation-enroll:${actor.tenantId}:${c.req.param('id')}`);
      const automation = await getAutomation(tx, actor.tenantId, c.req.param('id'));
      const journeys = await tx.list(actor.tenantId, 'automation_journey', { filters: { automationId: automation.id }, limit: 1 });
      if (automation.data.active || journeys.items.length) throw new ApiError(409, 'automation_in_use', 'Pause this automation to stop delivery. Automations with journey history cannot be deleted.');
      await tx.remove(actor.tenantId, 'automation', automation.id, automation.version);
    });
    return c.body(null, 204);
  });
  app.post('/automations/:id/enroll', async c => {
    const actor = authorize(c, 'publish');
    const input = await jsonBody(c, z.object({ subscriberId: z.string().min(1).max(200), idempotencyKey: z.string().min(1).max(200).optional() }).strict());
    const key = input.idempotencyKey || c.req.header('Idempotency-Key');
    if (!key) throw new ApiError(400, 'idempotency_required', 'Provide an Idempotency-Key header or idempotencyKey field.');
    const journey = await enrollAutomation(services, actor.tenantId, c.req.param('id'), input.subscriberId, key);
    return c.json(output(journey), 202);
  });
  app.get('/automations/:id/journeys', async c => {
    const actor = authorize(c, 'read');
    await getAutomation(services.store, actor.tenantId, c.req.param('id'));
    const status = c.req.query('status');
    if (status && !['queued', 'running', 'waiting', 'retrying', 'paused', 'completed', 'cancelled', 'failed'].includes(status)) throw new ApiError(400, 'invalid_status', 'Unknown journey status.');
    const page = await services.store.list(actor.tenantId, 'automation_journey', { ...pageOptions(c), filters: { automationId: c.req.param('id'), ...(status ? { status } : {}) } });
    return c.json({ items: page.items.map(output), nextCursor: page.nextCursor });
  });
  app.get('/automations/:id/journeys/:journeyId', async c => {
    const actor = authorize(c, 'read');
    const journey = await services.store.get(actor.tenantId, 'automation_journey', c.req.param('journeyId'));
    if (!journey || journey.data.automationId !== c.req.param('id')) throw new ApiError(404, 'not_found', 'Journey not found.');
    const executions = await services.store.list(actor.tenantId, 'automation_execution', { filters: { journeyId: journey.id }, limit: 100 });
    return c.json({ ...output(journey), executions: executions.items.map(record => { const { claimId: _claim, emailIntent: _intent, ...data } = record.data; return { id: record.id, ...data }; }) });
  });
  app.post('/automations/:id/journeys/:journeyId/cancel', async c => {
    const actor = authorize(c, 'publish');
    const record = await services.store.transaction(async tx => {
      await tx.lock(`automation-journey:${actor.tenantId}:${c.req.param('journeyId')}`);
      const journey = await tx.get<JourneyData>(actor.tenantId, 'automation_journey', c.req.param('journeyId'));
      if (!journey || journey.data.automationId !== c.req.param('id')) throw new ApiError(404, 'not_found', 'Journey not found.');
      if (terminal.has(journey.data.status)) return journey;
      return tx.update(actor.tenantId, 'automation_journey', journey.id, { ...journey.data, status: 'cancelled', reason: 'cancelled_by_member', completedAt: now() }, journey.version);
    });
    return c.json(output(record));
  });
}
