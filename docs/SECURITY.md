# Security model

Talisman is an early foundation. The controls below are implemented and tested;
the gaps after them are real and must be closed before a public multi-tenant
deployment.

## Implemented

| Control | Implementation | Test |
| --- | --- | --- |
| Passwords | scrypt (N=16384, r=8, p=1), per-password salt, timing-safe compare | `tests/auth.test.ts` |
| Sessions | 256-bit random tokens; only a peppered SHA-256 hash stored; 7-day expiry; revocable | `tests/auth.test.ts` |
| Cookies | httpOnly, SameSite=Lax, Secure in production | API |
| Cookie CSRF | cross-origin mutations refused when an `Origin` header is present | API middleware |
| Login throttling | per-email in-memory counter, 10 attempts / 15 minutes | code |
| Tenant isolation | `org_id` everywhere, RLS enabled + forced, non-superuser role, `SET LOCAL` context | `tests/db.test.ts` |
| Default deny | no tenant context = zero rows; write naming another tenant rejected | `tests/db.test.ts` |
| Per-user access | conversations and artifacts additionally filtered by `user_id` | `tests/db.test.ts` |
| Browser SSRF | http(s) only, no URL credentials, DNS resolution checked against private ranges, redirect re-checked | `tests/db.test.ts` policy unit coverage is pending; behaviour exercised by E2E with private access explicitly enabled |
| Egress allowlist | optional host allowlist; default any public host | code |
| Tool approval | tools marked `requiresApproval` denied unless an approver explicitly allows | `tests/intelligence.test.ts` |
| Task approvals | durable rows; denial fails the task; approvals expire in 24h | `tests/runtime.test.ts` |
| Workspace isolation | per-org/user/task root, traversal rejected, 0700/0600 modes | code |
| Artifact isolation | storage path must sit under the tenant prefix; download scoped to user | code |
| Audit | auth, task and approval mutations write `audit_events` | code |
| Secrets at rest | provider keys are never logged; encryption helper is **not** done | — |
| Production config | `SESSION_SECRET` required; private-network browsing refused | code |

## Gaps (do not treat as production-ready)

1. **Browser isolation.** Headless Chrome runs on the host with an isolated context
   but no container or VM. A browser exploit is a host exploit. OpenBot's Docker
   supervisor should own this.
2. **Credential encryption.** The table exists but no AES-GCM helper or API is
   implemented. Do not store provider keys there yet.
3. **SSO/SCIM.** Not implemented. Only email + password.
4. **Rate limiting** is in-memory; it resets on restart and does not work across
   processes.
5. **Audit exposure/retention** is not implemented; rows accumulate.
6. **Network egress** is controlled for the browser URL, not for model providers or
   future tools. There is no proxy enforcement.
7. **Prompt injection.** A research page can contain instructions. The browser
   pipeline only extracts text and never executes page-initiated actions, but
   model-driven browsing (planned) will need explicit tool authorisation.
8. **Resource limits.** Worker concurrency, browser timeout and page-size caps
   exist; there is no per-tenant quota or CPU/memory limit.
9. **No data retention/deletion API** for conversations, tasks or artifacts.
10. **Embedded dev Postgres** listens on loopback with a fixed password and is for
    local development only; never expose it or use it for real data.
11. **No malware/content scanning** for downloaded files; downloads are disabled in
    the browser, and artifacts are generated server-side.

## Deployment guidance

- Run behind TLS, with Postgres on a private network.
- Use a dedicated database role that can `SET ROLE talisman_app`; run migrations
  with an owner role.
- Set `SESSION_SECRET`, `DATABASE_URL`, `NODE_ENV=production`.
- Keep `BROWSER_ALLOW_PRIVATE=false`.
- Put the worker and API on the same private network, separate from the public
  ingress if possible.
- Treat `.data/` (workspaces, artifacts, embedded Postgres data) as private user data with backups
  and access controls.
