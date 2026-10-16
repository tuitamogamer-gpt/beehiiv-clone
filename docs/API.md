# Backend API guide

The API lives at `/api` on the app origin. Examples below use Bash, `curl` and `jq`. All IDs are returned by the server; never substitute another publication's IDs. Production endpoints require the configured database. See [setup and outstanding services](./BACKEND-REPORT.md) before attempting delivery or checkout.

## Start locally and create the first administrator

Use Node 24. Copy `.env.example` to the ignored `.env`, set a stable `SESSION_SECRET`, `APP_URL`, and the four administrator bootstrap values (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`, `PUBLICATION_NAME`). SQLite is available locally; production requires `DATABASE_URL` or `POSTGRES_URL`.

```bash
npm ci
npm run db:migrate
npm run db:bootstrap
npm run dev:api
```

Run `npm run dev` in another terminal. Remove `ADMIN_PASSWORD` from `.env` after bootstrap. Bootstrap creates the publication and admin membership; there is no unauthenticated account-creation endpoint.

Set the API origin and a private temporary directory for credentials:

```bash
export NEWSLETTER_ORIGIN='http://localhost:5173'
umask 077
NEWSLETTER_TEMP=$(mktemp -d)
curl --fail-with-body "$NEWSLETTER_ORIGIN/api/status" | jq
```

For production, replace the origin with your deployment URL. The local Vite server proxies `/api` to the API process. `/status` reports configuration, not a guarantee that every external provider is reachable.

## Login and inspect the publication

Read credentials without putting the password in shell history, send JSON on stdin, and store the HttpOnly session cookie in the private temporary directory:

```bash
read -r -p 'Admin email: ' NEWSLETTER_EMAIL
read -r -s -p 'Admin password: ' NEWSLETTER_PASSWORD
export NEWSLETTER_EMAIL NEWSLETTER_PASSWORD
jq -n '{email:env.NEWSLETTER_EMAIL,password:env.NEWSLETTER_PASSWORD}' |
  curl --fail-with-body -sS \
    -c "$NEWSLETTER_TEMP/cookies" \
    -H "Origin: $NEWSLETTER_ORIGIN" -H 'Content-Type: application/json' \
    --data-binary @- "$NEWSLETTER_ORIGIN/api/auth/login" | jq
unset NEWSLETTER_PASSWORD

curl --fail-with-body -sS -b "$NEWSLETTER_TEMP/cookies" \
  "$NEWSLETTER_ORIGIN/api/auth/me" | jq
curl --fail-with-body -sS -b "$NEWSLETTER_TEMP/cookies" \
  "$NEWSLETTER_ORIGIN/api/publication" > "$NEWSLETTER_TEMP/publication.json"
jq '{id,name,slug,sender,version}' "$NEWSLETTER_TEMP/publication.json"
```

Session mutations require an `Origin` matching `APP_URL`. Bearer API requests instead use a server-issued key and its scopes. Public reader sessions are separate from staff sessions; see the reader routes in the module index below.

Update publication settings with the version returned by GET. Replace the example sender with your own sender domain:

```bash
read -r -p 'Sender (for example Daily Brief <hello@your-domain.com>): ' NEWSLETTER_SENDER
export NEWSLETTER_SENDER
jq '{version, name:"Daily Brief", sender:env.NEWSLETTER_SENDER}' \
  "$NEWSLETTER_TEMP/publication.json" |
  curl --fail-with-body -sS -b "$NEWSLETTER_TEMP/cookies" \
    -X PATCH -H "Origin: $NEWSLETTER_ORIGIN" -H 'Content-Type: application/json' \
    --data-binary @- "$NEWSLETTER_ORIGIN/api/publication" | jq
```

This saves configuration; it does not prove domain ownership. A sender/domain change clears previous verification evidence.

## Create a scoped API key

Only an authenticated administrator session can create or revoke keys. The following key is sufficient for subscriber/draft/scheduling examples. It cannot administer teammates, payments, domains or other keys.

```bash
curl --fail-with-body -sS -b "$NEWSLETTER_TEMP/cookies" \
  -H "Origin: $NEWSLETTER_ORIGIN" -H 'Content-Type: application/json' \
  --data-binary '{"name":"Newsletter integration","scopes":["subscribers:read","subscribers:write","posts:read","posts:write","posts:send"],"expiresInDays":30}' \
  "$NEWSLETTER_ORIGIN/api/api-keys" > "$NEWSLETTER_TEMP/key.json"
NEWSLETTER_API_KEY=$(jq -r '.key' "$NEWSLETTER_TEMP/key.json")
NEWSLETTER_KEY_ID=$(jq -r '.id' "$NEWSLETTER_TEMP/key.json")
```

The secret is returned once. `GET /api/api-keys` lists safe metadata and `availableScopes`. A key remains bound to its publication and owner's current membership. Scope checks do not override role restrictions.

## Add an opted-in test subscriber and create a draft

Use an address you control and that has consented to receive the issue. Production validation checks the email domain's MX records. The administrative subscriber endpoint is different from public signup, which runs bot protection and double opt-in.

```bash
read -r -p 'Opted-in test recipient email: ' NEWSLETTER_RECIPIENT
export NEWSLETTER_RECIPIENT
jq -n '{email:env.NEWSLETTER_RECIPIENT,name:"Test Reader",status:"Active",source:"API test",tags:["test"],consent:{source:"owner-requested-test"}}' |
  curl --fail-with-body -sS \
    -H "Authorization: Bearer $NEWSLETTER_API_KEY" -H 'Content-Type: application/json' \
    --data-binary @- "$NEWSLETTER_ORIGIN/api/subscribers" > "$NEWSLETTER_TEMP/subscriber.json"
NEWSLETTER_SUBSCRIBER_ID=$(jq -r '.id' "$NEWSLETTER_TEMP/subscriber.json")

curl --fail-with-body -sS \
  -H "Authorization: Bearer $NEWSLETTER_API_KEY" -H 'Content-Type: application/json' \
  --data-binary '{"title":"Our first issue","subtitle":"A delivery check","content":"<p>Hello {{ first_name }},</p><p>This is our first issue.</p>","audience":"All subscribers"}' \
  "$NEWSLETTER_ORIGIN/api/posts" > "$NEWSLETTER_TEMP/post.json"
NEWSLETTER_POST_ID=$(jq -r '.id' "$NEWSLETTER_TEMP/post.json")

curl --fail-with-body -sS -G \
  -H "Authorization: Bearer $NEWSLETTER_API_KEY" \
  --data-urlencode 'channel=email' --data-urlencode 'tier=Free' \
  --data-urlencode "subscriberId=$NEWSLETTER_SUBSCRIBER_ID" \
  "$NEWSLETTER_ORIGIN/api/posts/$NEWSLETTER_POST_ID/render" \
  > "$NEWSLETTER_TEMP/preview.json"
jq '{subject,bytes,clippedRisk}' "$NEWSLETTER_TEMP/preview.json"
```

The renderer returns sanitized HTML/plain text plus the size gauge. Supplying a `subscriberId` requires subscriber-read permission. Drafts do not send email. Generic create/update operations cannot set a post to `Published` or `Scheduled`.

## Verify the sender, schedule, and run the worker

Configure Resend, the signed `/api/webhooks/resend` callback, `EMAIL_FROM`, a stable unsubscribe secret, and a running worker/scheduler first. Read [delivery setup](./delivery.md) for exact DNS ownership, DKIM, SPF and DMARC requirements.

```bash
read -r -p 'Resend domain ID: ' NEWSLETTER_DOMAIN_ID
export NEWSLETTER_DOMAIN_ID
jq -n '{providerDomainId:env.NEWSLETTER_DOMAIN_ID}' |
  curl --fail-with-body -sS -b "$NEWSLETTER_TEMP/cookies" \
    -H "Origin: $NEWSLETTER_ORIGIN" -H 'Content-Type: application/json' \
    --data-binary @- "$NEWSLETTER_ORIGIN/api/domains/verify" | jq
```

The first result supplies the publication's TXT ownership challenge. Add it and the provider DNS records, then repeat verification after propagation. A `needs_setup` response is not permission to send.

Scheduling below starts a **real campaign to every eligible subscriber in the draft's audience**, not only the preview subscriber. For a delivery test, use an isolated publication containing only your opted-in test address.

```bash
NEWSLETTER_SEND_AT=$(node -e 'process.stdout.write(new Date(Date.now()+60000).toISOString())')
export NEWSLETTER_SEND_AT
jq -n '{scheduledAt:env.NEWSLETTER_SEND_AT}' |
  curl --fail-with-body -sS \
    -H "Authorization: Bearer $NEWSLETTER_API_KEY" -H 'Content-Type: application/json' \
    --data-binary @- "$NEWSLETTER_ORIGIN/api/posts/$NEWSLETTER_POST_ID/schedule" | jq
```

A successful `202` means queued. Run `npm run worker` continuously in an environment configured against the same database, or schedule authenticated `GET /api/jobs/run` every minute using the separate `CRON_SECRET`. `npm run worker -- --once` processes currently due work once. Keep scheduler secrets separate from application API keys; an ordinary admin session cannot invoke the scheduler endpoint. Set `SCHEDULER_ENABLED=true` only after that worker or external scheduler is running.

```bash
curl --fail-with-body -sS -H "Authorization: Bearer $NEWSLETTER_API_KEY" \
  "$NEWSLETTER_ORIGIN/api/posts/$NEWSLETTER_POST_ID" | jq
curl --fail-with-body -sS -H "Authorization: Bearer $NEWSLETTER_API_KEY" \
  "$NEWSLETTER_ORIGIN/api/posts/$NEWSLETTER_POST_ID/analytics" | jq
```

Provider acceptance and delivery are separate states. Signed provider feedback determines delivered, bounced and complained counts. `/posts/:id/cancel` can cancel a scheduled run only before fanout starts.

## Pagination, versions, errors and limits

Most list routes return `{items, nextCursor}`. Request the next page with the opaque cursor from the same endpoint and keep filters unchanged. The cursor is not a page number or a stable export snapshot. Limits vary by endpoint, commonly 50–100 with a maximum of 500 in shared helpers.

```bash
curl --fail-with-body -sS -G -H "Authorization: Bearer $NEWSLETTER_API_KEY" \
  --data-urlencode 'limit=50' --data-urlencode 'status=Active' \
  "$NEWSLETTER_ORIGIN/api/subscribers" > "$NEWSLETTER_TEMP/page.json"
NEWSLETTER_CURSOR=$(jq -r '.nextCursor // empty' "$NEWSLETTER_TEMP/page.json")
# Only request another page when NEWSLETTER_CURSOR is nonempty.
curl --fail-with-body -sS -G -H "Authorization: Bearer $NEWSLETTER_API_KEY" \
  --data-urlencode 'limit=50' --data-urlencode 'status=Active' \
  --data-urlencode "cursor=$NEWSLETTER_CURSOR" \
  "$NEWSLETTER_ORIGIN/api/subscribers" | jq
```

Where accepted, send the latest record `version` on updates. A `409 version_conflict` means reread and reconcile edits; blindly retrying the same update will not fix it. There is no universal client idempotency header across every endpoint, so do not automatically repeat create/send operations after an unknown network outcome. Delivery jobs and Stripe checkout have their own domain-specific idempotency.

Errors use `{error:{code,message,details?,requestId?}}`; successful responses include `X-Request-Id`. Typical statuses:

| Status | Meaning |
| --- | --- |
| 400 / 422 | Invalid JSON, fields, filters or business input |
| 401 | Missing/expired authentication or invalid token |
| 403 | Role, scope, origin or entitlement check failed |
| 404 | Missing resource or resource outside the caller's publication |
| 409 | Stale version, duplicate, or an incompatible lifecycle state |
| 413 | Request/media size exceeds the supported limit |
| 429 | Rate limit; retry later with exponential backoff and jitter |
| 502 / 503 | Provider unavailable or required service not configured |

Authenticated API traffic has a shared limit of 600 requests per credential per minute. Additional limits apply: login 30/client and 10/email per 15 minutes; media upload 30/publication/minute; API-key creation 30/publication/hour; MCP 120/user/publication/minute; AI text 30/publication/hour; AI images 10/hour; audio and transcription 20/hour each. Public signup and reader login have stricter IP/email limits. These are current application limits, not contractual capacity guarantees. Errors do not currently guarantee a `Retry-After` header. Media uploads are limited to 4 MB; the server's request-body limit also applies to JSON and multipart overhead.

## Module index

| Area | Primary routes | Details |
| --- | --- | --- |
| Staff auth, memberships, keys | `/auth/*`, `/team/*`, `/api-keys` | [Authentication](./auth.md) |
| Workspace, publication, audit, jobs | `/workspace`, `/publication`, `/audit`, `/jobs`, `/jobs/run` | [Backend setup/report](./BACKEND-REPORT.md) |
| Subscribers, segments, automations | `/subscribers`, `/segments`, `/automations` | [Audience and automation APIs](./audience-automations.md) |
| Drafts, rendering, sending, suppression | `/posts`, `/domains/verify`, `/suppressions`, `/webhooks/resend` | [Delivery](./delivery.md) |
| Payments, community, podcasts | `/products`, `/commerce/*`, `/community/*`, `/podcasts/*`, `/webhooks/stripe` | [Commerce/community/podcasts](./commerce-community-podcasts.md) |
| Reader identity | `/public/:slug/reader/login`, `/verify`, `/me`, `/logout` | Separate `bh_reader` session; login requires an active subscriber and configured email |
| Webhooks, analytics, AI, MCP | `/webhooks`, `/analytics/*`, `/ai/*`, `/mcp` | [Integrations](./integrations.md) |
| Templates, website, comments, surveys | `/templates`, `/website/*`, `/posts/:id/comments`, `/surveys`, `/polls` | [Content APIs](./integrations.md) |
| Media | `/media`, `/media/:id/content`, `/media/:id/publish`, `/media/:id/public` | [Private media and explicit publication](./integrations.md#explicitly-publishing-media) |
| Forms, lists, referrals, telemetry | `/signup-forms`, `/newsletter-lists`, `/referral-links`, `/referral-rewards`, `/growth/*`, `/analytics/website` | Implemented in [`server/modules/growth.ts`](../server/modules/growth.ts); signup/referral constraints in the [backend report](./BACKEND-REPORT.md) |

The route index documents implemented handlers; it is not an OpenAPI specification or a guarantee that all handlers have a dedicated UI screen. Public form/embed, published page and podcast endpoints use publication slugs; authenticated APIs derive publication access from the session/key rather than trusting a supplied tenant ID.

When finished with the temporary integration key, revoke it using the admin session and remove local temporary credentials:

```bash
curl --fail-with-body -sS -b "$NEWSLETTER_TEMP/cookies" \
  -X DELETE -H "Origin: $NEWSLETTER_ORIGIN" \
  "$NEWSLETTER_ORIGIN/api/api-keys/$NEWSLETTER_KEY_ID"
unset NEWSLETTER_API_KEY
rm -rf -- "$NEWSLETTER_TEMP"
```
