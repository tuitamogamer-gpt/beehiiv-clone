# Commerce, reader accounts, community, and podcasts

These modules use the shared tenant-scoped SQL store, durable jobs, audit records, and webhook events. The frontend prototype is separate; these APIs are real persistence and authorization paths. No sales, followers, downloads, payment success, transcription, or live attendance are fabricated.

## Reader identity and access

`registerReaders` supplies a separate reader login system. Reader sessions **never populate the workspace `Principal`**, never grant a workspace role, and cannot open `/api/posts`, `/api/products`, `/api/workspace`, media-library management, or staff settings.

- `POST /api/public/:slug/reader/login` accepts `{email, botToken?}`. It issues the same 202 response for known and unknown addresses, applies durable IP/email rate limits, and requires Turnstile in production. Only existing `Active` subscribers receive mail. Transactional/global suppression rules also apply.
- Login delivery is a durable `reader.login_email` job. The token is hashed in its record and encrypted with AES-256-GCM in the job payload using `SESSION_SECRET`; it is not stored as plaintext in the outbox.
- `GET /api/public/:slug/reader/verify?token=...` follows the email link; `POST` with `{token}` is available for a reader UI. Tokens expire in 15 minutes and are consumed atomically once.
- `bh_reader` is a separate HttpOnly, SameSite=Lax cookie, Secure on HTTPS/production, scoped to `/api/public`. Sessions expire after 30 days. Every request rechecks subscriber existence, Active status, and the reader identity linkage. Login on one publication cannot authorize a different publication.
- `GET /api/public/:slug/reader/me` returns the authenticated reader profile. `POST .../reader/logout` revokes the persisted session and expires the cookie.
- Reader cookie mutations require an `Origin` exactly matching `APP_URL`'s origin. Missing/cross-site origins are rejected. `POST` verification and logout have the same guard. The emailed GET link is intentionally accepted from an external email client.
- A verified subscriber gets `readerUserId: "reader:<subscriber-id>"`. This namespace is distinct from workspace users. Purchases, private feeds, and community authorship use this identity. Workspace accounts may also exercise their own purchases through the staff API; subscriber rows linked by `userId` are supported separately.

Required for reader login: durable database, stable `SESSION_SECRET`, `APP_URL`, transactional `RESEND_API_KEY` and `EMAIL_FROM`, production Turnstile, and a running durable-job scheduler. The application must provide a reader-facing UI for these endpoints; a reader cookie is not a workspace login.

## Commerce

### Product catalog and pricing

- Staff `GET/POST /api/products`, `GET/PUT/DELETE /api/products/:id`. Admins and members may write; contributors cannot. Delete archives the product and prevents new checkout without revoking purchased assets.
- Product types include digital download, membership, course, coaching session, and webinar. The latter labels do not implement appointment scheduling or video streaming.
- Supported currencies: USD, EUR, GBP, CAD, AUD, NZD, SEK, NOK, DKK, JPY. Monetary values are validated for supported currency precision; Stripe receives integer minor units. Prices, descriptions, product variants, billing interval, and asset IDs are persisted.
- Every digital product/variant asset ID must refer to this tenant's private `media` record. Clients cannot supply an arbitrary delivery URL or another tenant's asset.
- Staff coupon endpoints: `GET/POST /api/commerce/coupons`, `DELETE /api/commerce/coupons/:id`. Codes are unique and case-normalized. Percentage/fixed amounts, currency, activation, expiry, redemption limits, and in-flight reservations are validated. Checkout expiry/failure webhooks release reservations.
- `GET /api/public/:slug/products` exposes active storefront products, prices, and variant descriptions without exposing private media IDs or staff data.

### Payments and subscriptions

Workspace authenticated routes:

| Endpoint | Function |
| --- | --- |
| `POST /api/commerce/checkout` | Stripe Checkout using `{productId, variantId?, couponCode?}` and a required `Idempotency-Key` |
| `GET /api/commerce/orders` | Own orders; admins may view tenant orders |
| `GET /api/commerce/subscriptions` | Own subscriptions; admins may view tenant subscriptions |
| `POST /api/commerce/portal` | Stripe billing portal for the caller's stored Stripe customer |
| `POST /api/commerce/subscriptions/:id/pause` | Provider-backed collection pause and access suspension |
| `POST /api/commerce/subscriptions/:id/resume` | Provider-backed collection resume |
| `POST /api/commerce/subscriptions/:id/cancel` | Provider-backed cancellation at period end |
| `POST /api/commerce/orders/:id/refund` | Admin-only Stripe refund, integer minor-unit amount optional |
| `POST /api/commerce/orders/:id/downloads` | Owner/admin generation of expiring purchased-file links |

Reader equivalents are `/api/public/:slug/checkout`, `/orders`, `/subscriptions`, `/portal`, `/subscriptions/:id/:action`, and `/orders/:id/downloads`. They require the independent reader cookie and same-origin mutations. Reader users cannot refund other customers or read admin order lists.

`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are required before accepting checkout. The implementation uses the Stripe SDK and an existing Stripe account. No Shopify dependency is used. No Stripe account, real customer, real payment, or real refund is created by the test suite.

Amounts come only from stored product/variant/coupon records. The client cannot set `amount`, payment status, a Stripe price ID, paid tier, customer ID, ownership, success URL, or cancellation URL. Checkout metadata and idempotency identifiers bind the provider object to its tenant, user, product, and persisted order. Redirects use configured `APP_URL`.

Stripe Checkout handles card collection. Memberships use monthly/yearly recurring prices. Pausing uses Stripe's `pause_collection` with voided invoices; it is **not** a prorated subscription schedule. Cancel requests preserve access until Stripe confirms the subscription has ended. Stripe processing fees apply; there is no added platform fee in these API calls. Tax calculation, tax registration, multi-account Stripe Connect onboarding, trials, gifts, and group-seat management are not implemented.

Configure a Stripe webhook endpoint at `/api/webhooks/stripe` for:

- `checkout.session.completed`, `checkout.session.async_payment_succeeded`
- `checkout.session.expired`, `checkout.session.async_payment_failed`
- `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
- `charge.refunded`

The exact raw body is signature-verified before parsing into trusted events. A transactional event-ID ledger prevents duplicate processing. Currency, final amount, session ID, order ownership, and metadata are checked before paid entitlement. Stale subscription events cannot overwrite newer persisted states. Refunds revoke digital downloads when the full payment is refunded. Subscriptions synchronize a mapped subscriber's Free/Premium tier from provider status; client-supplied tier values do not grant paid entitlements.

A confirmed order emits `order.paid`, increments actual product sales once, and triggers `purchase.completed` automations for an existing, mapped **Active** subscriber. No subscriber is silently created or bound to a workspace account from an unverified checkout email.

### Digital fulfillment

A paid order with assets and a buyer email queues `commerce.deliver`. The worker sends actual expiring download links through the configured transactional mail provider, observes subscriber suppression when linked, registers provider-message metadata, and records delivery only after provider acknowledgment. Delivery email retries use a stable provider idempotency key. No real email is sent in tests; an injected transport is used.

Download capabilities are backed by hashed tokens in SQL and expire after 10 minutes. `/api/commerce/downloads/:tenant/:token` checks the current order's paid state, owner linkage, and purchased asset list on **every** download, then streams `readMedia` bytes with attachment/no-store headers. It never redirects to a client-supplied URL. Refunded orders and expired tokens cannot retrieve files. Readers can request fresh links from their authenticated order endpoint.

Vercel Blob private storage is used in production. Development may use the root module's local media storage. The current media upload endpoint is limited to 4 MB, so large ebooks/audio require a future authenticated direct-upload flow. Download links are bearer capabilities and should not be logged or shared publicly.

## Community

All community data is tenant scoped. Workspace administrators/members are community administrators/managers; contributors and verified readers can author and manage their own content. Managers may moderate. Only administrators may ban members or remove channels. No public request can invent an author/user ID.

Staff management:

- Channel create/update/delete, access level `free` or `premium`, ordering, and an atomically selected default channel.
- Post publish/edit/delete, pin/hide moderation, threaded comments, reports, moderation resolution, member listing and ban/unban.
- Actual metrics count persisted members/posts/comments and recent active authors.

Member endpoints under `/api/community` have reader equivalents under `/api/public/:slug/community` for join, channel listing, channel posts, own post editing/deletion, post comments, reports, and direct messages. Staff management routes have **no** reader alias.

Premium channel content checks live subscription entitlement on every read/write. Bans are checked for every community route. Reports and deleted/hidden content cannot be used to bypass access checks. DMs derive the conversation identity from the authenticated sender and a real enrolled peer; unrelated users, including staff, cannot query another pair's private conversation through these endpoints. A subscriber must verify the reader login and join or create content to become a DM target.

Bodies are explicitly stored and returned as `format: "plain_text"`; clients must render them as text, never raw HTML. Community notification emails, push notifications, realtime sockets, Discord role synchronization, Luma events, and invitation campaigns are not implemented. Polling the authenticated API is available.

## Podcasts

Staff APIs under `/api/podcasts` provide show and episode CRUD, Apple category metadata, author/language/artwork, preserved episode GUIDs, draft/published/scheduled status, manual transcripts, and archiving. Contributors may draft and edit only their own unpublished episodes; only admins/members publish. Duplicate GUIDs within a show are rejected and GUIDs cannot be changed after creation.

- Publishing validates audio metadata. Public enclosures require public HTTPS audio URLs without credentials/private host patterns. MIME type, byte length, duration, episode/season, and XML text are validated.
- Scheduled publication uses the durable `podcast.publish` job, with transactionally emitted episode events. A configured scheduler is required; requests do not pretend a future episode has already published.
- Public RSS: `/api/public/:slug/podcasts/:showId/feed.xml`.
- Public show page and episode library: `/api/public/:slug/podcasts/:showId`.
- Public episode page: `/api/public/:slug/podcasts/:showId/episodes/:episodeId`.
- Feed XML escapes every text/attribute, uses audio enclosure MIME/length, preserves GUIDs, and excludes drafts, archived content, and future publication dates. Episode pages escape user text and use restrictive CSP headers.
- Admins can configure an HTTPS RSS redirect and `itunes:new-feed-url` for migration away. Directory submissions to Apple/Spotify/YouTube remain manual; the server does not claim the show is distributed merely because RSS exists.

Premium shows require private audio `mediaId` assets. Active subscribers may create a tokenized feed through `POST /api/public/:slug/podcasts/:id/private-feed` (workspace equivalent `/api/podcasts/shows/:id/private-feed`). Tokens are stored hashed. The feed checks paid entitlement on every request and replaces enclosures with protected streaming URLs; private file URLs are not exposed. Each audio request rechecks the token, current subscription, show, and episode before streaming private media bytes. Canceling/pausing a subscription immediately prevents new feed/audio requests. Tokens can be revoked through the authorized workspace endpoint; reader token-revocation UI remains to be added.

There is **no automatic transcription integration**: `/api/podcasts/episodes/:id/transcribe` explicitly returns 503. Manually supplied transcript text is supported. There is no claim of IAB-certified analytics, bot-filtered download counts, automated directory publishing, or import-from-URL discovery. GUID-preserving manual/API import is supported. Private streaming currently serves complete objects; HTTP byte-range seeking and large direct uploads remain future work.

## Not implemented or requiring external setup

- Stripe account credentials, webhook registration, billing-portal configuration, real payment-method testing, and operational reconciliation must be configured before live billing.
- Email provider credentials and a verified sender, production bot protection, PostgreSQL, private media storage, stable secrets, production HTTPS `APP_URL`, and cron/queue execution are required for their respective live workflows.
- Live webinars, screen sharing, attendee chat/recording, automatic webinar reminders, ticket scanning, attendee capacity, coaching-slot availability/booking, and calendar invites are not implemented. Product category labels do not imply these capabilities. They require a real streaming/calendar/booking integration and corresponding application work.
- No deliverability SLA, payment conversion, audience size, streaming capacity, or other operational performance number is guaranteed by this implementation.

## Verification

`server/tests/commerce.test.ts` uses actual SQLite and API requests. It covers restart persistence, money/variant validation, RBAC/tenant isolation, provider configuration failures, raw Stripe signature verification, webhook replay and amount mismatch, subscription synchronization/stale events, protected downloads, actual private-byte fulfillment, paid channel access/bans, author ownership/thread/report behavior, DM isolation, escaped RSS/GUID preservation, draft exclusion, private-feed entitlement revocation, scheduled jobs, reader token single-use, encrypted outbox payloads, CSRF rejection, and reader cookies being rejected by workspace auth. All payment operations are local signature/state tests; no real checkout or customer is created.
