# Newsletter workspace

A beehiiv-inspired React dashboard with a Node.js/Hono backend, PostgreSQL production storage, and SQLite for local development. The original demo remains available and keeps its sample data in the browser. The **Live workspace** uses authenticated server records and never imports the demo audience.

Read the [backend implementation and activation report](docs/BACKEND-REPORT.md) for the feature matrix, production requirements, and unfinished capabilities. This is an independent implementation, not the beehiiv service. Delivery rates, sending capacity, commercial networks, and staffing claims from the original request are not guarantees of this project.

## Run locally

Requires Node.js 24.

```sh
npm ci
cp .env.example .env
```

Set a persistent `SESSION_SECRET` in the private `.env` file, and enter `ADMIN_EMAIL`, `ADMIN_PASSWORD` (at least 12 characters), `ADMIN_NAME`, and `PUBLICATION_NAME`. Generate a secret with `openssl rand -hex 32`. Do not commit credentials.

```sh
npm run db:migrate
npm run db:bootstrap
```

Remove `ADMIN_PASSWORD` after creating the account. Run the API and frontend in separate terminals:

```sh
npm run dev:api
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to port 3001. Local records persist in `.data/newsletter.sqlite`, and private media files in `.data/media`; both are ignored by Git. Set `DATABASE_URL` to use PostgreSQL locally instead.

Run the durable worker in another terminal when testing scheduled jobs:

```sh
npm run worker
# Or process one batch:
npm run worker -- --once
```

Email, payment, bot protection and AI adapters call real providers only when their credentials are configured. Missing providers return explicit configuration errors. No provider credentials are needed to edit drafts, manage local audience records, or run the test suite.

## Backend

- Password and magic-link authentication, separate reader sessions, publication roles, invitations, scoped and revocable API keys.
- Subscriber validation, CSV import/export, consent confirmation, custom fields, segments, suppression and attribution.
- Sanitized email/web rendering, free/premium content, personalization, scheduled fanout, retries, provider event verification and unsubscribe handling.
- Versioned automation graphs, durable journeys, conditions, waits, email and webhook steps.
- Stripe products, checkout, verified order events, subscriptions, private digital delivery, community and podcast APIs.
- Signed outbound webhooks, MCP tools, AI text/images/audio/transcription, private media, content templates, page revisions, polls and surveys.
- Session-backed live controls for core publishing and audience work; additional modules are available through REST APIs. The demo's visual controls are separate simulations.

API paths and limitations are documented in [auth](docs/auth.md), [audience and automations](docs/audience-automations.md), [delivery](docs/delivery.md), [commerce/community/podcasts](docs/commerce-community-podcasts.md), [integrations/content](docs/integrations.md), and [growth](docs/growth.md).

## Verification

```sh
npm run test:backend
npm run build
```

The build checks both frontend and server TypeScript. Backend tests use isolated SQLite databases and injected transports; the optional PostgreSQL integration tests require `TEST_DATABASE_URL` pointing to a disposable database. They do not send real mail or charge real cards.

Browser checks live in `scratch/`. Install Chromium once with `npx playwright install chromium`, then run checks against a local server or set `BASE_URL` to a deployment. Screenshots go to the ignored `artifacts/` directory. Legacy demo checks must enter demo mode; they do not validate production providers.

## Production

Vercel serves the Vite build and the Node API from `api/index.ts`. Production requires PostgreSQL: there is deliberately no temporary SQLite fallback on serverless functions. Configure environment variables from [.env.example](.env.example) in Vercel, run `db:migrate` and `db:bootstrap` against that database from a trusted machine, then redeploy.

Jobs need an always-on worker or a scheduler calling `/api/jobs/run` every minute with `Authorization: Bearer CRON_SECRET`. A secret alone does not activate a scheduler. Set `SCHEDULER_ENABLED=true` only after connecting it. No recurring paid scheduler is silently provisioned.

Set up signed Resend and Stripe webhooks, verify sender-domain ownership and DNS, and test providers in their test environments before enabling public acquisition or paid delivery. See the report for exact callbacks, settings, limits, and remaining work.
