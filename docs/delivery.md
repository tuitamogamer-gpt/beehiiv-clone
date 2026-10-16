# Publishing and delivery backend

The delivery module sends through the injected `Services.sendEmail` adapter, which production connects to Resend. It persists posts, schedules, fanout batches, per-subscriber execution records, and verified provider events in the application store. No delivery, engagement, revenue, or domain verification metrics are generated from sample data.

## Activate sending

Configure PostgreSQL, a stable public `APP_URL`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, and a stable `SESSION_SECRET`. For long-lived unsubscribe links, set a separate `UNSUBSCRIBE_SECRET` of at least 32 characters; it otherwise falls back to the session secret, with the same minimum length. Rotating that signing secret invalidates previously issued unsubscribe URLs. Development's randomly generated session secret is unsuitable for persistent real email delivery.

Connect the Resend webhook to `POST /api/webhooks/resend` and subscribe to delivered, delivery-delayed, bounced, complained, opened, and clicked events. Copy the endpoint's `whsec_...` signing secret. Sending remains disabled without that secret because bounce and complaint feedback is necessary for suppression. Configure and run the authenticated durable job worker/cron described in the main backend documentation. Enqueuing a post does not run its jobs synchronously.

A publication needs a valid `sender`, such as `Daily Brief <hello@example.com>`. An administrator calls:

```http
POST /api/domains/verify
Content-Type: application/json

{"providerDomainId":"your-resend-domain-id"}
```

The first request returns `status: needs_setup` and a stable tenant-specific ownership challenge:

```json
{
  "ownership": {
    "type": "TXT",
    "name": "_newsletter-verification.example.com",
    "value": "newsletter-domain-verification=<random-value>",
    "status": "missing"
  }
}
```

Add that TXT record at the sender domain, configure the provider's DKIM/SPF records, and add one valid DMARC record. Call the same endpoint again after DNS propagation. Verification requires the ownership challenge, an exact sender-domain match, provider status `verified`, provider DKIM **and SPF TXT** records marked verified, and a valid DMARC record. A provider domain ID or arbitrary TXT record alone cannot grant a tenant permission to send from someone else's domain. Verified claims are recorded in the private delivery namespace. Verification evidence is refreshed after 24 hours; a changed or unverified sender pauses queued delivery.

SPF verification concerns the provider's envelope return-path domain. DMARC has to align at least one passing SPF/DKIM identity, and actual received headers and aggregate DMARC reports remain the authoritative operational check. The application does not claim that TXT presence proves successful receiver alignment. Its current check requires an exact DKIM sender-domain match and does not implement organizational-domain suffix inference or inherited DMARC-policy discovery.

## Post APIs

| Endpoint | Purpose | Access |
| --- | --- | --- |
| `GET /api/posts` | Cursor-paginated posts; optional status filter | `posts:read` |
| `POST /api/posts` | Create sanitized draft; optional `templateId` | Contributor/member/admin, `posts:write` |
| `GET /api/posts/:id` | Draft/post data | `posts:read` |
| `PATCH /api/posts/:id` | Edit with optional optimistic `version` | Contributor/member/admin, `posts:write` |
| `DELETE /api/posts/:id` | Delete an unscheduled post | Member/admin, `posts:write` |
| `GET /api/posts/:id/render` | `channel=email|web`, `tier=Free|Premium`, optional same-tenant `subscriberId` | `posts:read` |
| `POST /api/posts/:id/schedule` | Body `{scheduledAt: ISO timestamp}` | Member/admin, `posts:send` |
| `POST /api/posts/:id/cancel` | Cancel before fanout starts | Member/admin, `posts:send` |
| `GET /api/posts/:id/analytics` | Counts from accepted messages and signed provider events | `posts:read` |
| `GET /api/public/:slug/posts` | Published metadata only | Public |
| `GET /api/public/:slug/posts/:id` | Published free web rendering; premium edition for an authenticated, entitled reader | Public/reader session |

A generic write cannot set `Published` or `Scheduled`. Contributors may edit only Draft posts. Scheduled drafts are immutable until cancelled. Published posts can be edited for their web edition, but cannot be resent; duplicate them into a draft. Rendering uses an allowlist sanitizer, escaped merge values, and a final sanitization pass. Supported tags include `first_name`, `name`, `email`, `publication_name`, and custom subscriber fields. A `<!-- paywall -->` comment or an element carrying `premium-divider` marks the premium break. Free rendering omits the premium body before it is returned, including on anonymous requests that try to specify `tier=Premium`. The public web route upgrades only a valid same-publication reader session with an active paid entitlement. It rechecks the entitlement on each request, so cancellation/downgrade immediately revokes premium web access. A staff session or a subscriber `tier` field alone cannot bypass that check. Personalized pages use private/no-store caching and vary by Cookie.

Email rendering produces a presentation-table wrapper, inline styles, plain text, and an actual UTF-8 HTML byte count with a warning at 95 KiB. Unsupported active embeds and media are removed from email. Safe web audio/video can remain. This is a practical HTML renderer, not evidence of Outlook/Litmus certification across every email client.

Creating a post with `templateId` copies that template’s current content and style tokens. New posts without an explicit template use the publication default: its outline fills an empty draft, while its colors, font, base font size, and spacing apply to the renderer for the saved template channel. A post keeps a snapshot so a later template edit does not silently change an existing send; newly API-created posts pick up the latest version. Both create and patch support sanitized `prependContent` and `appendContent`, with a combined content limit. PATCH schemas have no creation defaults, so omitted fields are preserved.

The exported `renderSubscribeForm(publication, action)` produces a consent-based HTML form that posts to this application's public signup endpoint, with a honeypot and configured Turnstile widget. Audience validation, consent, and double opt-in are handled by the audience module.

## Durable send behavior

1. Scheduling verifies sending readiness, takes a content/publication snapshot, creates a durable `send_run`, and enqueues a fanout job with `runAt`. The post remains `Scheduled`.
2. The worker scans active subscribers in batches of 200. It respects all/free/premium audiences and stores a deterministic recipient key for every subscriber in a run. Pending/unsubscribed subscribers are excluded.
3. A random per-run salt assigns stable A/B subject cohorts. The article title remains unchanged. A second subject currently gets an approximately 50/50 split; there is no automatic winner selection or staged winning-subject rollout.
4. Each recipient rechecks its current subscription state and applicable suppressions before sending. Its complete personalized provider request and idempotency key are persisted before the external call, so normal retries reuse the same payload and unsubscribe URL. If its email address or subscription tier changes after a deferred attempt, that cached envelope is skipped rather than sent with stale identity or premium content.
5. The provider's acknowledgement ID is recorded separately from delivery. Only accepted messages count as sent; signed delivered events count as delivered. The post becomes `Published` only after all recipient jobs reach terminal states and at least one provider acknowledgement exists. An all-skipped/all-failed run returns the post to `Draft` with its actual counts.
6. Temporary API/SMTP-style deferrals retry on the durable worker's exponential schedule for at least 24 hours. Hard recipient failures are suppressed immediately. Mailbox-full and DNS failures are classified separately and remain retryable; exhausted temporary failures receive an expiring publication suppression.
7. A timeout or network failure can leave provider acceptance unknown. Retries reuse the provider idempotency key; before its approximately 24-hour retention expires, unresolved attempts are quarantined as `NeedsReview`, not resent under a new key. Operators must reconcile those attempts with the provider before taking further action. No application can truthfully promise exactly-once external delivery after an unknown network outcome without such reconciliation.

Once Resend has accepted a message, downstream SMTP retries and queue lifetime are the provider's responsibility. The application records signed `delivery_delayed` events and does not resend already accepted email. Confirm the provider's actual retry policy as part of your operating configuration. An exhausted or misconfigured worker job requires operator intervention; this implementation does not include an automated dead-letter repair interface.

## Suppressions and unsubscribe

Publication and transactional suppressions are scoped to their respective send classes. Global suppressions apply across publications in a private `__delivery__` registry. Only signed provider complaint/permanent-bounce events can create global suppressions; a tenant administrator cannot suppress another tenant's audience. Permanent rules never expire and cannot be deleted via the suppression API. Temporary rules expire through their timestamp and can be removed by an administrator.

`POST /api/suppressions` accepts `email`, `scope` (`publication` or `transactional` for manual writes), `reason`, `permanent`, and a required future `expiresAt` for temporary rules. `GET /api/suppressions` lists only the caller's publication rules. Global email addresses and rules are never exposed by that endpoint.

Every newsletter includes `List-Unsubscribe`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, a body unsubscribe link, a `Feedback-ID`, and publication/post/subscriber/cohort provider tags. Links contain a 256-bit random nonce and HMAC bound to the subscriber and tenant. GET shows a confirmation form, protecting against scanners that visit links; POST performs the RFC 8058 action without a login, changes the subscriber to `Unsubscribed`, and creates a permanent publication suppression. Repeated POSTs are idempotent. An unsubscription cannot change another publication's subscriber even if its URL path is edited.

Automation senders reuse `assertSenderReady`, `createUnsubscribeLink`, and `registerProviderMessage` so their signed provider events can be attributed and suppressions applied.

## Webhook authenticity and metrics

The webhook reads the raw body, verifies Svix's signature and timestamp, and only then parses JSON. It rejects absent, incorrect, and expired signatures. A durable inbox deduplicates by signed event ID. Processing is queued so a callback arriving before the outbound provider-ID mapping exists can be retried. Events with no matching application message never mutate an arbitrary subscriber.

Unique opens and clicks come from provider events. Known security scanners/bot user agents are flagged and their clicks excluded. Remaining engagement is explicitly labeled **unverified** because user-agent filtering does not prove that a click or open came from a human, and email privacy systems distort open rates. Complaint and hard-bounce events produce permanent global suppressions; temporary bounce classes produce expiring publication rules. Provider event payloads are retained for attribution and operational reconciliation.

## Tests and limits

`npx tsx --test server/tests/delivery.test.ts` uses the real SQLite store and durable worker with injected test email transport. It covers due-time enforcement, fanout idempotency, subscriber eligibility, premium rendering and paid-reader downgrade revocation, template snapshots/styles, PATCH omission preservation, subject/body separation, suppression expiry/scope, signed one-click unsubscribe, signed webhook replay protection, bot exclusion, complaint/global suppression, 24-hour retry behavior, unknown-acceptance quarantine, sender readiness, roles/scopes, and public paywall protection. A composed-app HTTP test also runs the same Node adapter used by the Vercel entrypoint, checks API path routing, and verifies a whitespace-sensitive signed body through middleware. Deployed Vercel rewrite behavior still requires a deployment smoke check. No test transport can be selected through a production request.

This module does not create a deliverability operations team, prove a 99.3% inbox-delivery rate, support a measured three-million-email-per-minute throughput, enroll mailbox feedback-loop programs, operate dedicated IP warmup/rotation, monitor public blocklists, ingest DMARC aggregate reports, purchase commercial click verification, implement true multiuser collaborative editing, or supply a Litmus-certified renderer. Those are provider capabilities, separate operational systems, or additional product work. The current worker intentionally sends individual messages with durable bookkeeping and needs capacity planning and load testing before large campaigns. The sender domain, secrets, provider account, DNS, database, job scheduler, and live provider webhooks must all be configured and exercised before real production sending.
