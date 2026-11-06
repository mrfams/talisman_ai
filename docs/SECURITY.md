# Security model

Talisman defaults to deny. This document separates what is implemented and
tested from what is still missing; the second list is the reason this is not a
hardened multi-tenant service yet.

## Implemented and tested

| Control | Implementation | Test |
| --- | --- | --- |
| Passwords | scrypt (N=16384, r=8, p=1), per-password salt, timing-safe compare | `tests/auth.test.ts` |
| Sessions | 256-bit random tokens; only a peppered SHA-256 hash stored; 7-day expiry; revocable | `tests/auth.test.ts` |
| Cookies | httpOnly, SameSite=Lax, Secure in production | API |
| Credential encryption | AES-256-GCM, 96-bit IV per record, AAD binding org + provider + user | `tests/connectors.test.ts` |
| Connector tokens | encrypted at rest, never returned to a client, per user within an org | `tests/connectors.test.ts` |
| OAuth state | HMAC-SHA256 over tenant, user, pinned redirect URI and a 10-minute expiry | `tests/connectors.test.ts` (forged state 403) |
| Connector writes | `calendar_create_event` requires an explicit approval | `tests/connectors.test.ts`, `tests/intelligence.test.ts` |
| Connector fail-closed | no key or no OAuth client refuses the request instead of degrading to plaintext | `tests/connectors.test.ts` |
| Cookie CSRF | a mutation whose `Origin` is present must match the host that served the request | `scripts/e2e-live.mjs` (403 on foreign origin) |
| Login throttling | per-email counter, 10 attempts / 15 minutes | code (in-process) |
| Tenant isolation | `org_id` everywhere, RLS enabled **and forced**, non-superuser role, `SET LOCAL` context | `tests/db.test.ts` |
| Managed-Postgres compatibility | migration grants `talisman_app` to the connecting role, so `SET ROLE` works where the owner is not a superuser; failure is swallowed only for that grant | live Neon deployment |
| Default deny | no tenant context returns zero rows; writes naming another tenant rejected | `tests/db.test.ts` |
| Per-user access | conversations, tasks and artifacts additionally filtered by `user_id` | `tests/db.test.ts`, live cross-tenant 404 |
| Browser SSRF | http(s) only, no URL credentials, DNS checked against private ranges, redirects re-checked | `tests/serverless.test.ts` |
| Tool approval | tools marked `requiresApproval` are denied without an explicit approver | `tests/intelligence.test.ts` |
| Task approvals | durable rows; denial fails the task; 24h expiry; a waiting task is not claimable | `tests/runtime.test.ts`, `tests/serverless.test.ts` |
| Execution leases | one executor per task; a timed-out slice releases its lease | `tests/serverless.test.ts` |
| Workspace isolation | per-org/user/task root, traversal rejected, 0700/0600 modes | code |
| Non-persistent workspace | on hosts without durable disk, workspace writes are skipped explicitly rather than silently failing | `tests/serverless.test.ts`, live E2E |
| Artifact isolation | filesystem path must sit under the tenant prefix; Postgres blobs are RLS-protected and read under the tenant role | `tests/serverless.test.ts` |
| Machine endpoints | `/api/internal/tick` and `/api/internal/migrate` require `CRON_SECRET` with a timing-safe compare; **unset secret disables both** | live migrate call |
| Audit | auth, task and approval mutations write `audit_events` | code |
| Production config | `SESSION_SECRET` required; private-network browsing refused in production | `src/core/config.ts` |

## Gaps (do not treat as production-ready for untrusted users)

1. **Only Google Calendar is wired.** Gmail, Composio and MCP connectors are
   still absent. Rotating `CREDENTIAL_ENCRYPTION_KEY` invalidates every stored
   token: users must reconnect, and there is no re-encryption job yet.
2. **No compute isolation.** The serverless function sandbox runs the model loop,
   but any computer/browser execution must supply its own isolation. The HTTP
   reader never executes JavaScript, which removes a whole class of browser
   exploits but also limits what pages return.
3. **Remote browsers are shared.** If `BROWSER_WS_ENDPOINT` is set, every tenant
   shares one remote browser session unless the provider isolates contexts.
4. **Rate limiting is in-process.** It resets on cold start and is not shared
   between instances.
5. **No per-tenant quotas.** Nothing caps model spend or task volume per account;
   an account can spend the deployment's provider balance.
6. **Audit rows have no read API or retention policy.**
7. **Prompt injection is not contained.** A page can contain instructions. The
   pipeline extracts text and never executes page-initiated actions, but a model
   that later gains browsing tools will need explicit tool authorisation.
8. **No data deletion API** for conversations, tasks, artifacts or memories.
9. **SSO/SCIM** is not implemented.
10. **Artifact bytes live in Postgres** on serverless. Fine for generated PDFs;
    the table needs retention and size caps before it accepts uploads.

## Deployment guidance

- Terminate TLS at the platform; keep Postgres on a private network.
- Set `SESSION_SECRET` and `CRON_SECRET`; rotate them if a deployment leaks.
- Keep `BROWSER_ALLOW_PRIVATE=false`.
- Run the migration with an owner role; run the application with a role that may
  `SET ROLE talisman_app`.
- Treat `.data/` as private user data, and back up Postgres rather than the disk.
- Do not expose `/api/internal/*` without `CRON_SECRET`; the endpoints exist only
  when the secret is set.
