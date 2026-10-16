# Integrations, content and AI backend

These are working HTTP handlers backed by the shared SQL store. The frontend does not yet expose every route. Paths below start with `/api`. Persisted data is isolated by the authenticated publication. Production requires PostgreSQL and a stable `SESSION_SECRET`; missing providers return explicit errors rather than simulated success.

## Webhooks

- `GET/POST /webhooks`, `PATCH/DELETE /webhooks/:id` create, update, enable, disable and remove endpoints. Administration requires the admin role and `integrations:read` or `integrations:write` API scope.
- `POST /webhooks/:id/rotate-secret` returns a replacement secret once. Creation also returns the secret once. Listing and logs never reveal it. Secrets use AES-256-GCM with authenticated tenant/endpoint binding; `SESSION_SECRET` derives the encryption key. Back this key up. Changing it requires rotating existing webhook secrets.
- Destinations must use HTTPS on port 443. DNS resolution rejects private/reserved addresses and the HTTP transport pins the validated IP. Redirects are not followed, responses are capped at 2 MB, and connections time out after 15 seconds.
- Choose event names or `*` on every endpoint. Emitted events enqueue durable `webhook.deliver` jobs. Automatic failures retry with the queue's exponential backoff, up to ten attempts. A configured scheduler/worker must actually run these jobs.
- `GET /webhooks/:id/deliveries` lists individual attempt logs; `POST /webhook-deliveries/:id/retry` queues another delivery. Disabled or removed endpoints do not send.
- Delivery is **at least once**. Consumers must deduplicate `webhook-id`. Stable event IDs are reused across retries, but the signing timestamp is fresh.

Current JSON payload:

```json
{
  "id": "event-uuid",
  "type": "subscriber.created",
  "api_version": "2026-10-01",
  "created_at": "2026-10-16T12:00:00.000Z",
  "publication_id": "publication-id",
  "data": { "subscriberId": "subscriber-id" }
}
```

Verify the exact raw body with HMAC-SHA256 using your endpoint secret and the input `${webhook-timestamp}.${rawBody}`. The `webhook-signature` header is `v1=<hex HMAC>`. Use a constant-time comparison and reject timestamps outside a five-minute tolerance. Only events that the implemented backend actually emits can be delivered; the original product feature list is not a promise that all named lifecycle events exist.

## Analytics and MCP

- `GET /analytics/summary` calculates subscriber totals/source attribution, delivery and engagement counts, mailbox-domain breakdowns and confirmed sales from stored records. It returns `null` for an unobserved delivery rate, never a claimed 99.3%. Financial amounts are minor currency units, separate per currency, after recorded refunds and before processor fees. It does not infer subscription renewal revenue without recorded charges.
- `GET /analytics/events?postId=...` paginates recorded provider events.
- Summaries currently read at most 20,000 records per collection. Larger publications need materialized rollups or an external warehouse. Email opens may include privacy proxies; click filtering is heuristic and is explicitly marked unverified.
- `POST /mcp` implements authenticated stateless HTTP JSON-RPC initialization, ping, tools/list and tools/call. Supported protocol version is `2025-03-26`; no SSE session stream or resources interface is implemented.
- Tools: actual analytics summary, listing posts/subscribers/segments/automations, reading a subscriber, and creating a sanitized post draft. Tools are filtered by role/API scopes, arguments are validated, and execution goes through the regular HTTP routes and authorization checks. There is no privileged MCP bypass.
- Create an API key with only the scopes your AI client needs, point its compatible HTTP MCP transport at `https://YOUR_DOMAIN/api/mcp`, and send `Authorization: Bearer YOUR_KEY`. Client-side AI translates natural-language requests into tools. This is not a separate autonomous agent service or a guarantee of compatibility with every client's transport.

## AI adapters

All AI endpoints require `ai:write`, `OPENAI_API_KEY` and enforce per-publication rate limits. Requests go to fixed OpenAI HTTPS endpoints. Provider errors, timeout and unconfigured credentials are explicit failures. Audit entries contain action/provider metadata, not the supplied prose or prompts. Costs are charged by OpenAI; no production request was executed or charged during local tests.

- `POST /ai/text`: `{action: "rewrite" | "translate" | "grammar" | "draft", text, language?, instruction?}`. Input is limited to 20,000 characters; output to 4,000 tokens. Default model `gpt-4.1-mini`; override `OPENAI_TEXT_MODEL`. Thirty requests per publication/hour.
- `POST /ai/images`: `{prompt, name?}`. Default model `gpt-image-1`, one 1024px low-quality WebP. The result is saved through the real image optimization/media pipeline. Requires `media:write`; production requires private Blob storage. Ten requests/hour. Override `OPENAI_IMAGE_MODEL` only with a compatible image model.
- `POST /ai/audio`: `{text, voice?, name?}`. Default `tts-1`, MP3, 4,096-character input limit and 20 requests/hour. Returns media ID/download URL plus an AI-generation disclosure. Override `OPENAI_AUDIO_MODEL` with a compatible speech model.
- `POST /ai/transcriptions`: `{mediaId, language?}`. Reads an owned audio asset, sends multipart audio to the transcription provider, and stores the returned transcript. Requires `media:read` and `media:write`; 20 requests/hour. Default `whisper-1`, override `OPENAI_TRANSCRIPTION_MODEL`.
- Uploads start private and use the existing 4 MB asset limit. Large podcasts/full-length newsletter narration require a chunking/batch pipeline that is not implemented. Synchronous provider operations time out after 45 seconds; slow generations fail instead of returning a fictional asset. Generated assets initially remain private. Publish image/audio assets explicitly with `POST /media/:id/publish` before using their returned capability URL in an email or website.

## Explicitly publishing media

`POST /media/:id/publish` requires the authenticated tenant, an authoring role and `media:write`. It returns an unguessable `https://YOUR_DOMAIN/api/public/media/...` capability URL for an owned image or audio asset. Anyone possessing this URL can read the asset; do not publish confidential content. Only the token hash is persisted. Publishing again rotates the URL, invalidating the old token at the server.

`DELETE /media/:id/public` requires an admin/member with `media:write` and revokes public access. Private authenticated access remains available. PDFs, text, CSV and ZIP attachments cannot be publicly exposed through this route, even if a token is present; use the protected product-delivery mechanism for purchases. The response uses `nosniff` and a sandbox CSP. It currently allows a private browser cache for 60 seconds, so previously fetched bytes may remain in a browser cache after revocation. Revocation cannot recall files already downloaded or email-provider image caches.

## Templates, website pages and editorial comments

- `/templates` supports cursor listing, create/update/delete and `POST /templates/:id/duplicate`. HTML is sanitized; templates store colors, supported fonts, size, spacing, channel and publication-default selection. The store enforces one default per publication. Post creation selects an explicit template or the publication default and snapshots its current content/style tokens; later template edits apply to newly created posts. Background, text/accent color, supported font, size and spacing are safely applied by the renderer. Posts also accept sanitized prepend/append content; see the delivery API for details.
- `/website/pages` supports draft CRUD, `/website/pages/:id/publish`, `/revisions` and `/restore`. Edits and restore change only the draft; publishing promotes it to the public version. Mutations keep revision snapshots, enforce optimistic versions where supplied, and reserve both published and draft slugs. Only admins/members manage website pages.
- `GET /public/:slug/pages/:pageSlug` renders the sanitized published page with escaped metadata, responsive HTML, a restrictive CSP and optional `noindex`. Premium pages require a current reader session with a real paid entitlement; publication admins/members can preview them. Anonymous requests do not receive premium HTML.
- `/website/redirects` stores internal-path redirects and rejects external targets and loops. `GET /public/:slug/resolve?path=/old` returns the configured destination/status. Your website router must use this result; this API does not reconfigure Vercel domain routing by itself.
- `/posts/:id/comments` lists/adds editorial comments with optional parent and content anchor. `/comments/:id` allows author text edits and editor resolution/deletion. Comments are plain text, author IDs come from the authenticated session, and cross-post/cross-publication thread references are rejected.
- Public page requests use the shared growth telemetry pipeline and daily aggregates. Referrers retain only their hostname, URL query strings are removed, and raw IP/user-agent values are not stored. Known bots are labeled using user-agent heuristics; visitors are not fingerprinted. The summary counts server page requests separately from client-reported page views to avoid double counting.

## Surveys and polls

- `/surveys` and `/polls` create/list forms, activate/close them, list individual responses and return per-question aggregates. Questions support text, single choice, multiple choice and 1–5 rating; a poll has one single-choice question. Questions are immutable after creation to preserve historical answer meaning.
- `POST /surveys/:id/response-link` or the matching poll route accepts an active `subscriberId`. It issues a random expiring capability link; only its hash is stored. The link is for that subscriber and form only.
- The public GET route returns the form (and optional aggregate results) after checking the capability. It does not mutate votes on GET, so an email link scanner cannot cast a vote merely by following a link.
- `POST /public/:slug/surveys/:id/responses` (or `/polls/`) accepts `{token, answers}`. Question IDs, answer types and choices are validated. Subscriber identity comes from the issued token, never a caller-supplied email or ID. An atomic unique response key prevents duplicate/replayed votes. Responses emit `survey.submitted` or `poll.submitted` webhook events.
- Staff need `content:read` plus `subscribers:read` to browse individual responses. Aggregates exclude free-text responses and subscriber identities. Capability links expire after 1–90 days and stop working for inactive subscribers.
- A reader-facing survey UI and inbox-native one-click voting blocks are not included in these server routes. GET returns JSON; it is ready for the corresponding form frontend. There is no automatic survey-to-segment custom-field mapping yet.

## Verification and remaining dependencies

`npx tsx --test server/tests/integrations.test.ts` tests secret binding/tampering, SSRF restrictions, role/scope/tenant isolation, webhook signatures and logs, truthful currency-separated metrics, MCP scope handling, unconfigured AI behavior, sanitized templates, draft/publish separation, optimistic revisions, paid-page protection, redirect loops, subscriber-bound response replay protection and editorial ownership.

Required user configuration: PostgreSQL, stable session secret, a running job scheduler, public app URL; OpenAI credentials and private Blob storage for AI/media. Provider delivery, live MCP-client compatibility, real OpenAI billing/model access and network webhook delivery still require deployment credentials and a configured endpoint to verify end to end.

Not implemented here: operational deliverability guarantees, an expert support team, dedicated-IP warming/blocklist removal, a native advertiser/recommendation marketplace, a full drag/drop or AI website-builder UI, custom-domain/DNS provisioning, robots.txt hosting, Google News submission, measured 80% page-speed claims, collaborative CRDT editing/presence, a built-in chat agent for every original feature, podcast distribution approval, live webinar streaming, or third-party integrations that need separate vendor accounts. Those are independent integrations/operations, not unlocked merely by deploying these handlers.
