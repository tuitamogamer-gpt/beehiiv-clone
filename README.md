# beehiiv-clone

A responsive, interactive beehiiv-inspired publishing dashboard built with React, TypeScript, and Vite.

## Run

Requires Node.js 24.

```sh
npm install
npm run dev
```

The development server listens on `0.0.0.0:5173`.

```sh
npm run build
npm run preview
```

## Working workflows

- Dashboard with interactive subscriber/engagement charts, period selection, acquisition breakdowns, recent posts, and onboarding.
- Post management, rich-text editing, slash commands, sanitized HTML, autosave, media blocks, personalized email/web previews, subject A/B configuration, audience selection, and local scheduling.
- Subscriber creation and validation, CSV import/export, status/tier filtering, profiles, tags, acquisition sources, and saved dynamic segments.
- Recommendation selection, referral reward configuration, and a signup form builder with a live preview.
- Product creation, editing, duplication, subscription pricing previews, and sample advertising offers/orders.
- Visual automation editing, step ordering, and local activation.
- Website customization with theme controls, desktop/mobile preview, post archives, and article previews.
- Newsletter, website, and mailbox-provider analytics using clearly illustrative data.
- Publication settings, DNS configuration examples, expiring/scoped suppression records, local team roles, and revocable demo API credentials.
- Global search (`Ctrl/Cmd + K`), new-post shortcut (`N`), notifications, and responsive navigation.

## Persistence and production scope

Changes are stored in this browser's localStorage. All metrics, sales, delivery activity, and account records are demonstration data. No live emails, payments, invitations, or external publications occur.

Production operation requires a backend, authenticated multi-user accounts and authorization, durable storage, queues, a verified email provider, DNS authentication, complaint and suppression processing, webhook delivery, payment integration, monitoring, and infrastructure validation. The 99.3% delivery rate and 3M+ messages/minute figures shown in deliverability settings are illustrative targets, not measured or guaranteed capabilities. This application does not implement the complete production feature list, native real-time collaboration, AI services, podcast hosting, community messaging, or live webinars.

## Verification

`npm run build` runs strict TypeScript validation and a production build. Browser checks in `scratch/flows.mjs`, `scratch/management.mjs`, and `scratch/smoke.mjs` exercise the core workflows, saved-state behavior, sanitization, and responsive layouts using Playwright. Start the dev server before running those scripts, or set `BASE_URL` to test a deployed instance. Screenshots are written to the ignored `artifacts/` directory. Install the browser once with `npx playwright install chromium`.

## Deployment

`vercel.json` configures a Vite build with `npm ci`, `npm run build`, and the `dist` output directory. No runtime environment variables are required for this frontend demo.
