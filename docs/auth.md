# Authentication and publication access

The backend uses real server-side accounts, sessions, publication memberships, invitations and API credentials. Browser demo records are not authentication credentials.

Production requires PostgreSQL, `APP_URL` with the public HTTPS URL, and a stable `SESSION_SECRET` of at least 32 characters. Login links and invitations additionally require `RESEND_API_KEY` and a verified `EMAIL_FROM`. Missing configuration returns an explicit service-unavailable response. The development secret is generated per process when omitted, so restarting the server invalidates its sessions; set a stable secret for persistence.

## Initial administrator

The CLI imports `bootstrapAdmin(store, { email, password, name, publicationName })` from `server/modules/auth.ts`. It creates a user, tenant, publication and administrator membership in one locked database transaction. Email addresses are normalized, existing accounts are rejected, and passwords require at least 12 characters. There is no public bootstrap route. Keep passwords out of shell history and committed files; the CLI should read them from a prompt or environment variable.

Passwords use scrypt (`N=32768`, `r=8`, `p=1`, a random 16-byte salt, and a 64-byte derived key). Unknown accounts perform the same password derivation work as known accounts, with constant-time hash comparison and a minimum response duration. Failed logins have the same generic response. Login attempts are limited per account and client address. These measures reduce account-enumeration timing differences; network and database delays are not guaranteed to be identical.

## Session routes

All paths below are prefixed by `/api`.

| Method | Path | Request / behavior |
| --- | --- | --- |
| POST | `/auth/login` | `{email,password}`; returns the account and selected publication |
| POST | `/auth/logout` | Revokes the presented server session and removes its cookie |
| GET | `/auth/me` | Returns user, `publicationId`, `tenantId`, current role and publication memberships |
| POST | `/auth/switch-publication` | `{publicationId}`; verifies membership and rotates the session |
| POST | `/auth/magic-link` | `{email}`; generic 202 response for configured delivery |
| POST | `/auth/magic-link/verify` | `{token}`; consumes a valid token once and creates a session |

The `bh_session` cookie is HttpOnly, SameSite=Lax, scoped to `/`, and Secure on HTTPS or in production. Sessions expire after seven days. Only HMAC-SHA256 token hashes are persisted; the random 32-byte token is returned only in the cookie. Login and publication switching rotate session tokens. Cookie-authenticated mutations must also pass the application's global same-origin check; do not expose these routes through a permissive credentialed CORS policy.

Magic links point to `APP_URL/?magic_token=...`. The frontend must remove that query parameter promptly from browser history and submit it to the verify route. Tokens expire after 15 minutes and are consumed atomically. Requests for unknown accounts return the same body, and no message is sent. Provider failures are reported, never converted into successful fake delivery. No raw token is stored in database records or audit events. Link-bearing emails necessarily contain the token and should not be logged.

## Publication roles and teams

Every authenticated request rechecks the user's active membership. Removing a member invalidates access through existing sessions and API keys on the next request. API authorization always uses the current membership role, not a role supplied by a client or an old cookie.

Administrators manage team membership and API keys. Members may list the team. Contributors cannot manage or list team accounts; their authoring permissions are enforced by the content endpoints. Role changes and member removal use transaction locks and preserve at least one administrator.

| Method | Path | Request / behavior |
| --- | --- | --- |
| GET | `/team` | Lists members of the selected publication |
| PATCH | `/team/:memberId` | `{role:"admin"|"member"|"contributor"}` |
| DELETE | `/team/:memberId` | Removes a membership immediately |
| GET | `/team/invitations` | Lists invitation metadata with cursor pagination |
| POST | `/team/invitations` | `{email,name?,role?}`; sends a real invitation email |
| DELETE | `/team/invitations/:invitationId` | Revokes an outstanding invitation |
| POST | `/team/invitations/accept` | `{token,name?,password?}`; accepts once |

Invitations expire after seven days and link to `APP_URL/?invitation_token=...`. A new account must provide a name and password. An existing account must authenticate using the invited email or prove its current password alongside the invitation token; this also lets a previously removed member rejoin. An invitation alone never changes its password or silently logs it in. Invitations become unusable if their inviting administrator loses administrator access. Reissuing an invitation revokes earlier invitations for that email in the publication. No invitation token appears in list responses.

## API credentials

Administrators with a user session can list, create and revoke keys through `GET /api-keys`, `POST /api-keys` and `DELETE /api-keys/:keyId`. Creation accepts `{name,scopes,expiresInDays?}` and returns the `bhk_...` key exactly once. Expiry can be one to 365 days; omission creates a key without a scheduled expiry. Revoke unused keys explicitly.

Database keys are indexed by SHA-256 hash and retain only a display prefix, owner, tenant, allowed scopes and expiry metadata. Bearer keys cannot create further keys or switch publications. The API-key account response exposes only its selected publication. Each endpoint must call `principal`, `requireRole` and `requireScope` as appropriate: authentication middleware alone does not authorize access.

The supported scopes are returned as `availableScopes` by `GET /api-keys` and exported as `API_SCOPES`. There is deliberately no wildcard scope in key creation. Team API access requires `team:read` or `team:write` as well as the applicable role; workspace account access requires `workspace:read`.

## Verification

Run `npx tsx --test server/tests/auth.test.ts`. Tests use SQLite in memory and an injected email transport, so they never send external messages. They cover password hashing, duplicate-account atomicity, session hashing and logout, generic login errors and limits, tenant switching, membership revocation, one-use and expired magic links, missing provider configuration, invitation identity checks, last-admin protection, API scope enforcement, cross-tenant identifiers, key revocation and production cookie configuration.
