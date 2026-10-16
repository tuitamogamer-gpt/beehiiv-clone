import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { Api, EmailMessage, Principal, Stored, Variables } from '../contracts.js';
import { ApiError, hash, now } from '../core/http.js';
import { config } from '../core/config.js';
import { createSqliteStore } from '../core/store.js';
import { createServices } from '../core/services.js';
import { automationGraphSchema, enrollAutomation, registerAutomations, triggerAutomations, type AutomationNode } from '../modules/automations.js';

const admin: Principal = { userId: 'owner', tenantId: 'tenant-a', role: 'admin' };
const simple: AutomationNode[] = [{ id: 'start', type: 'trigger', event: 'manual' }];
async function fixture() {
  const store = await createSqliteStore(':memory:');
  const sent: EmailMessage[] = [];
  const services = createServices(store, { sendEmail: async message => { sent.push(message); return { id: `email-${sent.length}` }; } });
  const app: Api = new Hono<{ Variables: Variables }>();
  let actor: Principal | undefined = admin;
  app.use('*', async (c, next) => { if (actor) c.set('principal', actor); await next(); });
  app.onError((error, c) => error instanceof ApiError ? c.json({ code: error.code, message: error.message }, error.status as 400) : c.json({ code: 'unexpected', message: String(error) }, 500));
  registerAutomations(app, services);
  const request = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const create = async (nodes: AutomationNode[] = simple) => {
    const response = await request('POST', '/automations', { name: 'Welcome', nodes });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json() as Promise<any>;
  };
  const publish = async (automationId: string) => {
    const response = await request('POST', `/automations/${automationId}/publish`, {});
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<any>;
  };
  const subscriber = async (status = 'Active', extra: Record<string, unknown> = {}) => store.insert('tenant-a', 'subscriber', { name: 'Sam Reader', email: `sam-${Math.random()}@example.com`, status, tier: 'Free', source: 'website', tags: [], ...extra });
  const drain = async () => { for (let index = 0; index < 20; index++) { const result = await services.runJobs(100); if (result.processed === 0) return; } throw new Error('Worker did not settle.'); };
  const seedLive = async (nodes: AutomationNode[]) => store.insert('tenant-a', 'automation', { name: 'Seeded published workflow', description: '', steps: [], nodes, active: true, enrolled: 0, liveRevision: 1, live: { name: 'Seeded published workflow', description: '', nodes, publishedAt: now() } });
  return { store, services, app, sent, request, create, publish, subscriber, drain, seedLive, setActor: (value: Principal | undefined) => { actor = value; } };
}

test('automation graphs reject cycles, dangling links, disconnected nodes, duplicate IDs, and unbounded graphs', () => {
  assert.equal(automationGraphSchema.safeParse(simple).success, true);
  assert.equal(automationGraphSchema.safeParse([]).success, true);
  const invalid: unknown[] = [
    [{ id: 'a', type: 'trigger', event: 'manual', next: 'b' }, { id: 'b', type: 'delay', seconds: 1, next: 'b' }],
    [{ id: 'a', type: 'trigger', event: 'manual', next: 'missing' }],
    [...simple, { id: 'unreachable', type: 'delay', seconds: 1 }],
    [...simple, ...simple],
    Array.from({ length: 101 }, (_, index) => ({ id: `n${index}`, type: index === 0 ? 'trigger' : 'delay', ...(index === 0 ? { event: 'manual' } : { seconds: 1 }), ...(index < 100 ? { next: `n${index + 1}` } : {}) })),
    [{ id: 'a', type: 'trigger', event: 'manual', next: 'b' }, { id: 'b', type: 'condition', condition: { field: 'customField', customField: '__proto__', operator: 'exists' } }],
  ];
  for (const nodes of invalid) assert.equal(automationGraphSchema.safeParse(nodes).success, false);
});

test('authentication, scopes, roles and tenant isolation govern automation routes', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  f.setActor(undefined);
  assert.equal((await f.request('GET', '/automations')).status, 401);
  f.setActor({ ...admin, apiKeyId: 'limited-key', scopes: ['posts:read'] });
  assert.equal((await f.request('GET', '/automations')).status, 403);
  f.setActor({ ...admin, role: 'contributor' });
  const automation = await f.create();
  assert.equal((await f.request('POST', `/automations/${automation.id}/publish`, {})).status, 403);
  assert.equal((await f.request('PATCH', `/automations/${automation.id}`, { name: 'Contributor draft' })).status, 200);
  f.setActor({ ...admin, tenantId: 'tenant-b' });
  assert.equal((await f.request('GET', `/automations/${automation.id}`)).status, 404);
  const response = await f.request('GET', '/automations');
  assert.deepEqual((await response.json() as any).items, []);
});

test('draft publication is explicit and existing journeys preserve their published snapshot', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const empty = await f.create([]);
  assert.equal((await f.request('POST', `/automations/${empty.id}/publish`, {})).status, 422);
  assert.equal((await f.request('POST', '/automations', { name: 'Forged', active: true, enrolled: 100 })).status, 422);
  const workflow = await f.create();
  const live = await f.publish(workflow.id);
  const subscriber = await f.subscriber();
  const journey = await enrollAutomation(f.services, admin.tenantId, workflow.id, subscriber.id, 'welcome');
  assert.equal(journey.data.revision, 1);
  assert.equal((await f.request('PATCH', `/automations/${workflow.id}`, { name: 'New draft', expectedVersion: live.version })).status, 409, 'Enrollment incremented the stored record version.');
  const updated = await f.request('PATCH', `/automations/${workflow.id}`, { name: 'New draft', nodes: [{ id: 'new-start', type: 'trigger', event: 'manual' }] });
  assert.equal(updated.status, 200);
  const draft = await updated.json() as any;
  assert.equal(draft.name, 'New draft');
  assert.equal(draft.live.name, 'Welcome');
  await f.publish(workflow.id);
  await f.drain();
  const completed = await f.store.get(admin.tenantId, 'automation_journey', journey.id);
  assert.equal(completed?.data.status, 'completed');
  assert.deepEqual(completed?.data.nodes, simple);
  assert.equal(completed?.data.revision, 1);
});

test('concurrent enrollment is idempotent and rejects inactive or foreign subscribers', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const workflow = await f.create(); await f.publish(workflow.id);
  const active = await f.subscriber();
  const [first, second] = await Promise.all([
    enrollAutomation(f.services, admin.tenantId, workflow.id, active.id, 'same-business-event'),
    enrollAutomation(f.services, admin.tenantId, workflow.id, active.id, 'same-business-event'),
  ]);
  assert.equal(first.id, second.id);
  assert.equal((await f.store.get(admin.tenantId, 'automation', workflow.id))?.data.enrolled, 1);
  for (const status of ['Pending', 'Unsubscribed']) {
    const inactive = await f.subscriber(status);
    await assert.rejects(enrollAutomation(f.services, admin.tenantId, workflow.id, inactive.id, status), (error: unknown) => error instanceof ApiError && error.code === 'subscriber_inactive');
  }
  await assert.rejects(enrollAutomation(f.services, 'tenant-b', workflow.id, active.id, 'foreign'), (error: unknown) => error instanceof ApiError && error.status === 404);
  assert.equal((await f.request('POST', `/automations/${workflow.id}/enroll`, { subscriberId: active.id })).status, 400);
  assert.equal((await f.request('DELETE', `/automations/${workflow.id}`)).status, 409);
});

test('event triggers persist jobs and apply acquisition filters without duplicate journeys', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const workflow = await f.create([{ id: 'signup', type: 'trigger', event: 'subscriber.created', source: 'website' }]); await f.publish(workflow.id);
  const included = await f.subscriber();
  const excluded = await f.subscriber('Active', { source: 'partner' });
  await f.store.transaction(async tx => {
    await triggerAutomations(f.services, admin.tenantId, 'subscriber.created', included.id, 'event-1', tx);
    await triggerAutomations(f.services, admin.tenantId, 'subscriber.created', included.id, 'event-1', tx);
    await triggerAutomations(f.services, admin.tenantId, 'subscriber.created', excluded.id, 'event-2', tx);
  });
  await f.drain();
  const journeys = await f.store.list(admin.tenantId, 'automation_journey');
  assert.equal(journeys.items.length, 1);
  assert.equal(journeys.items[0].data.subscriberId, included.id);
  assert.equal(journeys.items[0].data.status, 'completed');
});

test('conditions select one path, delays persist due times, duplicate jobs cannot re-execute nodes', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const workflow = await f.create([
    { id: 'start', type: 'trigger', event: 'manual', next: 'tier' },
    { id: 'tier', type: 'condition', condition: { field: 'tier', operator: 'equals', value: 'Premium' }, yes: 'premium', no: 'free' },
    { id: 'premium', type: 'delay', seconds: 60 },
    { id: 'free', type: 'delay', seconds: 3600, next: 'done' },
    { id: 'done', type: 'condition', condition: { field: 'tags', operator: 'contains', value: 'reader' } },
  ]);
  await f.publish(workflow.id);
  const subscriber = await f.subscriber();
  const journey = await enrollAutomation(f.services, admin.tenantId, workflow.id, subscriber.id, 'branch');
  await f.drain();
  const waiting = await f.store.get(admin.tenantId, 'automation_journey', journey.id);
  assert.equal(waiting?.data.status, 'waiting');
  assert.equal(waiting?.data.currentNodeId, 'done');
  assert.ok(Date.parse(waiting!.data.nextRunAt) > Date.now() + 3500_000);
  const executions = await f.store.list(admin.tenantId, 'automation_execution', { filters: { journeyId: journey.id } });
  assert.deepEqual(new Set(executions.items.map(record => record.data.nodeId)), new Set(['start', 'tier', 'free']));
  const duplicate: Stored = { id: 'duplicate', tenantId: admin.tenantId, kind: 'job', data: { payload: { journeyId: journey.id, nodeId: 'free' } }, version: 1, createdAt: now(), updatedAt: now() };
  await f.services.handlers.get('automation.node')!(duplicate, f.store);
  assert.equal((await f.store.list(admin.tenantId, 'automation_execution', { filters: { journeyId: journey.id } })).items.length, 3);
  const future = Date.now() + 3_601_000;
  t.mock.method(Date, 'now', () => future);
  await f.drain();
  assert.equal((await f.store.get(admin.tenantId, 'automation_journey', journey.id))?.data.status, 'completed');
});

test('pause parks journeys and resume continues them; unsubscribe cancels before a step runs', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const workflow = await f.create(); await f.publish(workflow.id);
  const subscriber = await f.subscriber();
  const journey = await enrollAutomation(f.services, admin.tenantId, workflow.id, subscriber.id, 'pause');
  assert.equal((await f.request('POST', `/automations/${workflow.id}/status`, { active: false })).status, 200);
  await f.drain();
  assert.equal((await f.store.get(admin.tenantId, 'automation_journey', journey.id))?.data.status, 'paused');
  assert.equal((await f.request('POST', `/automations/${workflow.id}/status`, { active: true })).status, 200);
  await f.drain();
  assert.equal((await f.store.get(admin.tenantId, 'automation_journey', journey.id))?.data.status, 'completed');
  const second = await enrollAutomation(f.services, admin.tenantId, workflow.id, subscriber.id, 'unsubscribe');
  await f.store.update(admin.tenantId, 'subscriber', subscriber.id, { ...subscriber.data, status: 'Unsubscribed' });
  await f.drain();
  assert.equal((await f.store.get(admin.tenantId, 'automation_journey', second.id))?.data.status, 'cancelled');
});

test('marketing suppression cancels email delivery before checking provider or invoking transport', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const subscriber = await f.subscriber();
  const workflow = await f.seedLive([{ id: 'start', type: 'trigger', event: 'manual', next: 'email' }, { id: 'email', type: 'email', subject: 'Welcome', html: '<p>Hello</p>' }]);
  await f.store.insert(admin.tenantId, 'suppression', { email: subscriber.data.email, emailHash: hash(subscriber.data.email), scope: 'global', permanent: true, active: true, reason: 'complaint' });
  const journey = await enrollAutomation(f.services, admin.tenantId, workflow.id, subscriber.id, 'suppressed');
  await f.drain();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.store.get(admin.tenantId, 'automation_journey', journey.id))?.data.status, 'cancelled');
  const executions = await f.store.list(admin.tenantId, 'automation_execution', { filters: { journeyId: journey.id } });
  assert.equal(executions.items.find(record => record.data.nodeId === 'email')?.data.status, 'skipped');
});

test('webhook private destinations are blocked and permanent worker errors are reflected in journeys', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const workflow = await f.create([{ id: 'start', type: 'trigger', event: 'manual', next: 'hook' }, { id: 'hook', type: 'webhook', url: 'https://127.0.0.1/private' }]);
  await f.publish(workflow.id);
  const subscriber = await f.subscriber();
  const journey = await enrollAutomation(f.services, admin.tenantId, workflow.id, subscriber.id, 'private-webhook');
  await f.drain();
  assert.equal((await f.store.get(admin.tenantId, 'automation_journey', journey.id))?.data.status, 'failed');
  const executions = await f.store.list(admin.tenantId, 'automation_execution', { filters: { journeyId: journey.id } });
  const failed = executions.items.find(record => record.data.nodeId === 'hook');
  assert.equal(failed?.data.status, 'failed');
  assert.equal(failed?.data.lastError, 'unsafe_url');
});

test('email retries reuse a durable request, sanitize HTML, carry one-click headers, and register provider attribution', async t => {
  const f = await fixture(); t.after(() => f.store.close());
  const previousConfig = { resendApiKey: config.resendApiKey, resendWebhookSecret: config.resendWebhookSecret };
  config.resendApiKey = 'test-provider-key'; config.resendWebhookSecret = 'test-webhook-key';
  t.after(() => Object.assign(config, previousConfig));
  await f.store.insert(admin.tenantId, 'publication', {
    sender: 'Newsletter <news@example.com>',
    verifiedDomain: { domain: 'example.com', provider: 'resend', providerDomainId: 'domain-1', status: 'verified', verifiedAt: now(), ownershipVerified: true, alignedSender: true, dkim: 'verified', spf: 'verified', dmarc: 'configured' },
  });
  const subscriber = await f.subscriber('Active', { name: '<script>alert(1)</script>' });
  await f.store.insert(admin.tenantId, 'suppression', { email: subscriber.data.email, scope: 'transactional', active: true, permanent: true });
  await f.store.insert(admin.tenantId, 'suppression', { email: subscriber.data.email, scope: 'publication', active: true, permanent: false, expiresAt: new Date(Date.now() - 1000).toISOString() });
  f.services.sendEmail = async message => {
    f.sent.push(structuredClone(message));
    if (f.sent.length === 1) throw new ApiError(503, 'provider_timeout', 'Ambiguous temporary transport failure.');
    return { id: 'provider-accepted-1' };
  };
  const workflow = await f.create([{ id: 'start', type: 'trigger', event: 'manual', next: 'email' }, { id: 'email', type: 'email', subject: 'Hi {{name}}', html: '<p>Hello {{name}}</p><script>alert(2)</script><img src="https://example.com/image.png" onerror="alert(3)">' }]);
  await f.publish(workflow.id);
  const journey = await enrollAutomation(f.services, admin.tenantId, workflow.id, subscriber.id, 'retry-email');
  await f.drain();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.store.get(admin.tenantId, 'automation_journey', journey.id))?.data.status, 'retrying');
  assert.ok(!f.sent[0].html.includes('<script>'));
  assert.ok(!f.sent[0].html.includes('onerror='));
  assert.ok(f.sent[0].html.includes('&lt;script&gt;'));
  assert.ok(f.sent[0].headers?.['List-Unsubscribe']?.includes('/api/public/unsubscribe/'));
  assert.equal(f.sent[0].headers?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  await f.store.update(admin.tenantId, 'subscriber', subscriber.id, { ...subscriber.data, name: 'Changed between retries' });
  const future = Date.now() + 65_000;
  t.mock.method(Date, 'now', () => future);
  await f.drain();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[0], f.sent[1], 'Retries must reuse the precise persisted provider request.');
  assert.equal((await f.store.get(admin.tenantId, 'automation_journey', journey.id))?.data.status, 'completed');
  const attribution = await f.store.get('__delivery__', 'provider_message', hash('provider-accepted-1'));
  assert.equal(attribution?.data.automationId, workflow.id);
  assert.equal(attribution?.data.journeyId, journey.id);
  const executions = await f.store.list(admin.tenantId, 'automation_execution', { filters: { journeyId: journey.id } });
  const email = executions.items.find(record => record.data.nodeId === 'email');
  assert.equal(email?.data.attempts, 2);
  assert.equal(email?.data.providerMessageId, 'provider-accepted-1');
  const response = await f.request('GET', `/automations/${workflow.id}/journeys/${journey.id}`);
  const detail = await response.json() as any;
  assert.ok(detail.executions.every((execution: Record<string, unknown>) => !('emailIntent' in execution)), 'Prepared provider requests are internal execution state.');
  f.services.sendEmail = async message => { f.sent.push(message); throw new ApiError(503, 'provider_timeout', 'Ambiguous timeout.'); };
  const uncertainJourney = await enrollAutomation(f.services, admin.tenantId, workflow.id, subscriber.id, 'expired-idempotency');
  await f.drain();
  assert.equal(f.sent.length, 3);
  const uncertainExecution = (await f.store.list(admin.tenantId, 'automation_execution', { filters: { journeyId: uncertainJourney.id, nodeId: 'email' } })).items[0];
  await f.store.update(admin.tenantId, 'automation_execution', uncertainExecution.id, { ...uncertainExecution.data, emailIntentAt: new Date(Date.now() - 86_400_000).toISOString() }, uncertainExecution.version);
  const retry: Stored = { id: 'expired-retry', tenantId: admin.tenantId, kind: 'job', data: { payload: { journeyId: uncertainJourney.id, nodeId: 'email' } }, version: 1, createdAt: now(), updatedAt: now() };
  await assert.rejects(f.services.handlers.get('automation.node')!(retry, f.store), (error: unknown) => error instanceof ApiError && error.code === 'provider_acceptance_unknown');
  assert.equal(f.sent.length, 3, 'Uncertain delivery must not resend outside the provider idempotency window.');
  assert.equal((await f.store.get(admin.tenantId, 'automation_journey', uncertainJourney.id))?.data.status, 'failed');
});
