# Audience and automation backend

Audience records are tenant scoped, persisted in PostgreSQL in production, and never seeded with engagement statistics. SQLite is a development/test adapter. `subscriber.created`, `.updated`, `.confirmed`, `.unsubscribed`, and `.deleted` events are persisted through the event service. No signup or import invents opens, clicks, or revenue.

## Audience API

- `GET /api/subscribers` supports `limit`, opaque `cursor`, `status`, `tier`, `source`, and normalized `email` filters.
- `POST /api/subscribers`, `GET/PATCH/DELETE /api/subscribers/:id` provide normalized, validated subscriber CRUD. Read and write operations require admin/member roles plus subscriber scopes for API keys; contributors cannot read audience data. Optional `version` on PATCH rejects stale writes.
- `POST /api/subscribers/import` accepts `{csv, source?}`, up to 4 MB and 10,000 rows. Production imports support at most 100 unique email domains per request, checked in bounded concurrent DNS batches with a five-second timeout. It preserves supplied Unsubscribed status, custom source attribution and tags; skips invalid, existing and within-file duplicate addresses; returns row errors. Imports do not reactivate existing opt-outs. Name, email, status, tier, source and tags are supported CSV columns; tags are semicolon-separated.
- `GET /api/subscribers/export` requires admin role and emits a CSV with formula-prefixed cells neutralized for spreadsheet use.
- Custom fields are flat named string, numeric, boolean or null values; nested objects are rejected. Tags are deduplicated. Email addresses are case-normalized. Per-email database transaction locks prevent concurrent duplicate creation.
- Email syntax, known disposable-domain and common typo checks run for every insertion/update/import. Production also checks DNS MX. The local disposable list is a baseline, not a third-party mailbox-ownership or comprehensive disposable-provider verification service. `checkMx` accepts a resolver injection for deterministic tests.

## Public signup

`POST /api/public/:slug/subscribe` accepts JSON or HTML forms. Required fields are `email` and affirmative `consent`. Optional inputs include `name`, `source`, `customFields` (JSON only), `website` honeypot, `startedAt` timestamp, and `turnstileToken` / `cf-turnstile-response`. Public clients cannot choose a paid tier or trusted tags.

Requests use durable IP and email-address rate limits. Production fails closed if Turnstile is not configured or a token fails verification. A honeypot and suspicious completion timing receive the same generic success response without creating a subscriber. IP routing headers must be set by the deployment proxy.

Signup also accepts `formId`, `listIds`, `referralCode`, and `utm` attribution. HTML forms can send repeated `listIds` fields plus `utm_source`, `utm_medium`, and `utm_campaign`. Referenced forms must be published and selected lists must be active/public and permitted by the form. Membership stays pending until double opt-in completes; referral credits are issued once after activation. See [growth API](./growth.md).

Double opt-in defaults to enabled. A real email provider and sender configuration are required before sending confirmation instructions. Transactional and global suppressions are checked before sending confirmation messages. Only the SHA-256 token hash is stored, tokens expire in 24 hours, are invalidated when superseded, and are consumed atomically once through `GET/POST /api/public/:slug/confirm`. The raw token appears only in the sent confirmation email. Existing active/unsubscribed addresses receive a generic response without being reactivated. Confirmation sends are throttled and use provider idempotency keys. Without double opt-in, new subscribers become Active after bot checks and affirmative consent.

## Segments

`/api/segments` supports create/list/read/update/delete. Static segment memberships are validated against the current tenant. Dynamic segments evaluate all/any condition sets over subscriber identity, status, tier, source, tags, persisted engagement fields, join date and custom fields. Operators support equality, inequality, containment, numeric comparisons and presence.

`GET /api/segments/:id/subscribers` evaluates current records and returns an opaque subscriber cursor; scanning per request is bounded, so a page may be empty while a continuation cursor exists. `POST /api/segments/:id/recalculate` persists the actual current count and timestamp. `GET /api/segments/:id/export` requires admin role. Dynamic results update at query time; cached counts update only on explicit recalculation.

Exports and explicit recalculations currently materialize their collection; they are not a claim of tested million-record bulk processing. Core subscriber list pagination does not load the entire collection. Large bulk exports/recalculations should be moved to streamed jobs before very large audiences are onboarded.

## Suppression and delivery

`emailSendEligibility(store,tenantId,subscriberId,scope)` requires an Active subscriber and checks local suppression records plus the reserved platform delivery suppression namespace. A global suppression applies to both publication and transactional contexts. Per-publication and transactional suppressions apply to their context. Permanent suppressions never expire; expired temporary records stop blocking automatically. Platform global records can only be written by trusted delivery-event handlers, not public signup or ordinary users.

## Automations

The execution contract below describes structured node schemas, durable enrollment and execution, draft/live versioning, idempotency, supported branching, and limitations. Signup/create/confirm/update transactions enqueue trigger evaluation for active subscribers, using stable event IDs. Pending or unsubscribed readers cannot receive automation emails.


# Automation backend

`registerAutomations(app, services)` installs the REST routes and durable worker handlers. All records are scoped to the authenticated tenant. Contributors can create and edit drafts; only members and administrators can publish, activate, delete, enroll readers, or cancel journeys. API keys additionally require `automations:read` or `automations:write`.

## Routes

| Method | Route | Behavior |
| --- | --- | --- |
| GET / POST | `/api/automations` | Paginated list / create draft |
| GET / PATCH / PUT | `/api/automations/:id` | Read / update draft |
| POST | `/api/automations/:id/publish` | Validate graph, verify email sender when needed, snapshot draft and activate |
| POST | `/api/automations/:id/status` | `{ "active": true/false }`; resume / pause |
| DELETE | `/api/automations/:id` | Delete an inactive automation without journey history |
| POST | `/api/automations/:id/enroll` | `{ "subscriberId": "...", "idempotencyKey": "..." }`; alternatively use `Idempotency-Key` header |
| GET | `/api/automations/:id/journeys` | Paginated journey history; optional `status` |
| GET | `/api/automations/:id/journeys/:journeyId` | Journey with actual node executions and provider IDs |
| POST | `/api/automations/:id/journeys/:journeyId/cancel` | Stop future steps |

Pagination accepts `limit` from 1–100 and an opaque `cursor`. Updates, publish, and status requests accept `expectedVersion` for optimistic concurrency. Unknown input fields are rejected. A GET returns both `nodes` (draft) and `live.nodes` (published) for comparison. The enrollment count is incremented transactionally on successful new enrollment. No opens, clicks, or revenue are synthesized.

## Workflow format

```json
{
  "name": "Welcome journey",
  "description": "A welcome note after signup",
  "steps": ["Subscriber signs up", "Wait one day", "Send welcome"],
  "nodes": [
    { "id": "signup", "type": "trigger", "event": "subscriber.created", "next": "wait" },
    { "id": "wait", "type": "delay", "seconds": 86400, "next": "welcome" },
    { "id": "welcome", "type": "email", "subject": "Welcome, {{first_name}}", "html": "<p>Thanks for joining, {{name}}.</p>" }
  ]
}
```

`steps` are optional presentation labels. They do not execute. An empty `nodes` array can be saved as a draft but cannot be published. Structured graphs must contain exactly one trigger, at most 100 nodes, unique IDs, valid edges, no cycles, and no disconnected nodes. A missing or null next edge ends the journey. Each reader follows one path; a condition selects one branch.

Supported nodes:

- `trigger`: `event` is `manual`, `subscriber.created`, `subscriber.confirmed`, `subscriber.updated`, or `purchase.completed`; optional exact-match `source`, `tier`, and `tag` filters. Subscriber/product event producers must call the integration helper below.
- `delay`: integer `seconds` from 1 to 31,536,000. The successor is queued with a persisted future `runAt`; no process sleeps.
- `email`: subject and sanitized HTML. Supports `{{name}}`, `{{first_name}}`, and `{{email}}`. Uses the publication's verified sender, a table-based HTML wrapper, an unsubscribe footer, and RFC 8058 one-click headers. Delivery requires the configured provider, valid domain, and the publishing module's sender-readiness checks.
- `condition`: `{ "field": "tier", "operator": "equals", "value": "Premium" }` with `yes`/`no` edges. Fields are source, tier, status, tags, or customField (requires `customField` name). Operators are equals, not_equals, contains, and exists.
- `webhook`: HTTPS `url`, optional scalar `payload`, and `next`. POST body includes version, event, automation/journey/node IDs, subscriber identity and fields, and configured payload. `safeFetch` rejects private destinations, credentials, non-HTTPS URLs, and redirects. Requests carry a stable `Idempotency-Key`; the receiving system must honor that key to prevent duplicate side effects after ambiguous responses.

## Lifecycle and durability

Draft edits leave live workflows unchanged. Publishing creates a new live revision. Enrollment stores that revision's entire graph, so existing journeys retain their original content and delays after a later publication.

Only Active subscribers can enroll. The worker rechecks subscriber status at every step and checks global/publication suppression immediately before marketing email delivery. Inactive subscribers and suppressed email recipients are cancelled. Suppression expiry is handled by the audience eligibility helper. Pausing prevents new enrollments and parks current journeys when their next jobs execute. Resuming queues parked journeys in batches. Already accepted external requests cannot be recalled by pause or cancellation.

Each enrollment key derives a unique journey record. Each journey/node pair has one execution record protected by a database lock and a lease. A prepared email request is persisted before sending, and retries reuse its exact body and provider idempotency key. Execution completion, provider-message attribution, next-step enqueueing, and journey advancement share a transaction. The durable queue retries transient failures; permanent failures and exhausted attempts leave explicit failed journey/execution records. Email provider idempotency is subject to the provider's retention window. An uncertain prepared request older than 23 hours 59 minutes is stopped with provider_acceptance_unknown for reconciliation instead of being blindly resent after Resend's 24-hour deduplication window. This implementation does not claim mathematically exact-once external delivery.

Run the shared durable worker on a recurring schedule. A stored delay only executes when a worker runs after its due time. Production requires the common PostgreSQL store and configured email provider; this module makes no delivery-rate, infrastructure-capacity, or managed-deliverability guarantee.

## Module integration

```ts
// Call inside the transaction that activates a subscriber or records a purchase.
await triggerAutomations(services, tenantId, 'subscriber.created', subscriber.id,
  `${subscriber.id}:created`, tx);

// For explicit API / application enrollment (the helper owns a transaction when tx is absent).
await enrollAutomation(services, tenantId, automationId, subscriberId,
  'stable-business-event-id', tx);
```

Event IDs must be stable across retries. Trigger jobs paginate active automations and enroll only matching subscribers. Register the module before running the worker so `automation.trigger`, `automation.node`, and `automation.resume` handlers are present. The audience module exports `emailSendEligibility`; the delivery module exports `assertSenderReady`, `createUnsubscribeLink`, and `registerProviderMessage`.

This is the workflow execution backend. The existing visual editor's string labels do not create executable nodes by themselves. Drag-and-drop graph editing, reusable condition libraries, bulk step reordering, and per-email analytics presentation require their corresponding UI/integration work.
