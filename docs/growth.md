# Growth, forms, lists, referrals and website measurement

`registerGrowth(app, services)` adds tenant-scoped growth APIs. Members and administrators may use them; API keys need `growth:read` or `growth:write`. Subscriber-specific lists, attribution, referral links, and rewards also require the indicated subscriber read/write scope. Contributors cannot manage growth or access subscriber attribution through these routes.

## Newsletter lists

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET / POST | `/api/newsletter-lists` | Paginated lists / create list |
| GET / PATCH / DELETE | `/api/newsletter-lists/:id` | Read / update / archive |
| GET / POST | `/api/newsletter-lists/:id/members` | Paginated memberships / subscribe or unsubscribe an Active subscriber |
| DELETE | `/api/newsletter-lists/:id/members/:subscriberId` | Record an unsubscribe while preserving history |

A list has `name`, `description`, `public`, and `active`. Membership changes are idempotent for a subscriber/list pair and emit newsletter-list subscription events. Public signup may select only active public lists. Double-opt-in signups create pending memberships; the confirmation hook activates them. Archiving a list keeps its history and stops new memberships. These preferences are persisted; the existing newsletter send audience selector does not yet target list membership.

## Reusable signup forms

`/api/signup-forms` supports GET and POST; `/api/signup-forms/:id` supports GET, PATCH, and DELETE. POST `/:id/publish` copies the current draft to a live snapshot. GET `/:id/embed` returns a public URL and iframe markup. Updates accept an optional optimistic `version`; an unpublished draft cannot render publicly.

The fixed form renderer at `/api/public/:slug/forms/:id` supports validated colors and fonts, presentation layout settings, public list choices, explicit newsletter consent, a hidden honeypot, submission timing, and the configured Turnstile widget. The page uses a nonce-constrained fixed submission script; user-supplied scripts and arbitrary HTML are not accepted. Labels, titles, values and messages are HTML-escaped.

Submissions POST to the existing `/api/public/:slug/subscribe` endpoint. That endpoint owns address validation, bot protection, rate limits, existing-address handling and double opt-in. The form displays its configured success message or navigates to a configured HTTPS success redirect after the generic accepted response. An accepted response does not disclose whether an address already existed. With JavaScript disabled, the same form submits directly and receives that endpoint's JSON response.

Optional iframe URL parameters `utm_source`, `utm_medium`, `utm_campaign` and `referralCode` are carried into the signup. A cross-origin iframe cannot inspect the embedding page's URL; the embedding site must add the desired parameters to its iframe URL. Form definitions can restrict embedding through their `allowedOrigins` Content Security Policy. An empty list permits HTTPS embedding sites. Production public signup still requires configured bot protection and, when double opt-in is enabled, a working confirmation email provider.

The audience module spreads `growthSignupFields` into its strict public request schema. URL-encoded form parsing preserves repeated list checkbox values using `parseBody({ all: true })`.

```ts
// Inside the transaction creating a NEW subscriber; does not mutate subscriber version.
await recordGrowthSignup(services, tx, tenantId, subscriber, {
  formId, listIds, referralCode, utm: { source, medium, campaign }
});

// Inside the transaction activating a Pending subscriber.
await confirmGrowthSignup(services, tx, tenantId, activatedSubscriber);
```

Attribution is written once per new subscriber. Existing active and unsubscribed addresses are not reenrolled or reassigned to another referrer by repeating the public signup request. Attribution parameters describe submitted acquisition information; they are not independently verified advertising data.

## Referrals and recommendations

- `/api/referral-links`: GET a paginated list or POST `{ "subscriberId": "..." }` to create/reuse an active reader's public referral code; DELETE `/:id` revokes it. Append the returned code as `referralCode` to a published signup form URL.
- `/api/referral-milestones`: GET, POST, PATCH `/:id`, and DELETE `/:id` manage milestone names, descriptions, thresholds and active state.
- `/api/referral-rewards`: GET actual earned rewards; POST `/:id/fulfill` records that a team member fulfilled a reward manually.
- `/api/growth/referrals`: paginated per-referrer credited signup counts.
- `/api/growth/attribution`: paginated subscriber acquisition records with form, selected lists and UTM values.
- `/api/recommendations`: GET, POST, PATCH `/:id`, and DELETE `/:id` manage a publication's recommendation directory. GET `/api/public/:slug/recommendations` returns active public entries with cursor pagination.

A referral is credited only once when the referred subscriber is Active. With double opt-in enabled, that occurs after confirmation. With double opt-in disabled, the explicit-consent signup activates immediately. Self-referrals, inactive referrers, disabled links and links from other publications cannot earn a credit. Pending referrals whose link is revoked before confirmation receive no credit. Threshold crossings create durable earned rewards and events. Reward delivery is manual, and milestones are evaluated on newly confirmed referrals; changing thresholds does not retroactively recalculate existing readers.

This directory does not claim access to an external recommendation network. There are no paid recommendations, advertiser payouts, artificial subscriber counts, fraud-verification claims, automated reward delivery, or automatic clawbacks after later unsubscribes.

## Website events and reports

POST `/api/public/:slug/pageviews` accepts:

```json
{
  "eventId": "75caf168-7ca5-4997-ac3b-62e141a55bb7",
  "path": "/articles/example",
  "referrer": "https://partner.example/newsletter",
  "utm": { "source": "partner", "medium": "email", "campaign": "launch" }
}
```

Use a new UUID per observed page view and reuse it when retrying that event. The endpoint validates the publication slug and request Origin against the application origin or configured publication domain, applies rate limiting, and deduplicates events transactionally. CORS preflight supports those configured origins. Origin validation limits browser access; it does not authenticate a visitor or prove a client is human.

Stored events omit raw IP addresses and raw user-agent strings. Paths lose query strings and fragments, referrers become hostnames, device values are coarse, and UTM fields have bounded formats. Paths themselves may still contain identifiers if the site's URL structure puts them there. The shared rate limiter uses a hash of the trusted request IP; growth events do not store that hash. No cross-site identifier or persistent visitor fingerprint is created.

`classifyWebsiteAgent` uses an explicitly labeled user-agent heuristic with `likely_bot`, `not_identified_as_bot`, and `unknown` results. User agents can be spoofed. These counts are not verified humans or unique readers. There is no claim of commercial click verification or equivalent bot filtering.

The content module calls `recordWebsiteRequest(services, tenantId, { path, referrer, userAgent })` for actual server page requests. Those events use source `page_request`; browser telemetry uses source `page_view`. Each source has separate daily aggregates so a single visit is not silently counted twice.

GET `/api/analytics/website` returns real recorded counts, date/path/channel breakdowns, and the explicit classification method. Filters are `from`, `to`, `source`, `path`, `channel`, `device`, `botClassification`, and `referrerHost`. The default is today's client `page_view` series. Choose `source=page_request` for server requests. Date ranges are at most 91 days. Daily aggregation scans are bounded to 20,000 matching dimension groups; excessive cardinality returns an error requiring narrower filters rather than silently returning incomplete totals. `uniqueVisitors` is null because no visitor identity is collected.

These APIs do not automatically install a browser tracker, geolocate visitors, connect Google Analytics, verify ad attribution, or implement a retention/deletion scheduler. Published page requests are measured by the server hook; websites wanting client page-view telemetry must call the public endpoint. Existing raw events recorded before the aggregation hook was added are not backfilled into daily reports.

## Verification

`server/tests/growth.test.ts` uses the real SQLite store and durable service layer. It covers tenant/role/scope restrictions, membership idempotence, draft/live forms, HTML escaping, confirmation-dependent referral credit, revoked/self-referral rejection, private-list rejection, telemetry origin checks and deduplication, privacy minimization, source-separated analytics, recommendations, and real public signup attribution. Test transports are injected only in test fixtures; production requests cannot enable a fake sender.
