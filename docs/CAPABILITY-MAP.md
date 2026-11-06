# Capability matrix

Status vocabulary: **NOT INSPECTED**, **INSPECTED**, **VENDORED**, **INTEGRATED**,
**VERIFIED**, **BLOCKED**, **NOT ADOPTED**.

A capability is VERIFIED only when it is wired into Talisman and a test in this
repository exercises it. "VENDORED" means the upstream source is present and
attributed but is not executed by Talisman. Nothing below is marked VERIFIED on
the strength of a README or of source being present.

## Talisman core (the application that runs today)

| Capability | Implementation | Status | Evidence |
| --- | --- | --- | --- |
| Multi-user accounts, orgs, memberships | `src/auth/service.ts`, `src/db/schema.sql` | VERIFIED | `tests/auth.test.ts` |
| Session handling (hashed tokens, cookies, bearer) | `src/auth/*`, `src/api/app.ts` | VERIFIED | `tests/auth.test.ts`, live signup |
| Tenant isolation (Postgres RLS + role switch) | `src/db/schema.sql`, `src/db/database.ts` | VERIFIED | `tests/db.test.ts` (3 tests), live cross-tenant 404 |
| Conversation + message state | `src/db/repos.ts`, `src/api/app.ts` | INTEGRATED | `tests/api.test.ts`, `tests/db.test.ts` |
| Model provider abstraction (OpenAI-compatible, Anthropic) | `src/intelligence/providers/*` | VERIFIED | `tests/intelligence.test.ts` (2 tests) |
| Model routing, fallback, allowlist | `src/intelligence/router.ts` | VERIFIED | `tests/intelligence.test.ts` |
| Streaming responses | provider SSE parsers, `POST /api/conversations/:id/messages` | VERIFIED | `tests/intelligence.test.ts`, live model call |
| Tool-call orchestration with default-deny approval | `src/intelligence/agent.ts` | VERIFIED | `tests/intelligence.test.ts` |
| Context budgeting and memory injection | `src/intelligence/context.ts` | VERIFIED | `tests/intelligence.test.ts` |
| Durable tasks: plan, steps, progress, events | `src/runtime/engine.ts`, `src/runtime/planner.ts` | VERIFIED | `tests/runtime.test.ts`, live E2E |
| Pause / resume / cancel / retry | engine + `/api/tasks/:id/*` | VERIFIED | `tests/runtime.test.ts` (5 tests) |
| Human approvals, durable and default-deny | `approvals` table, engine gate, decision API | VERIFIED | `tests/runtime.test.ts` |
| Execution receipts (events, step output, audit) | `task_events`, `audit_events` | VERIFIED | `tests/runtime.test.ts`, live E2E |
| Browser research on real pages | `src/browser/playwright.ts` | VERIFIED | `tests/browser.smoke.test.ts`, `tests/e2e.research.test.ts` |
| HTTP page reader (no JS engine) | `src/browser/http.ts` | VERIFIED | `tests/serverless.test.ts`, live E2E |
| Remote browser over CDP | `src/browser/playwright.ts` (`connectOverCDP`) | INTEGRATED | not exercised: needs an endpoint |
| Browser egress policy / SSRF defence | `src/browser/url-policy.ts` | VERIFIED | `tests/serverless.test.ts` (private host), E2E redirect re-check |
| Document composition and PDF rendering | `src/documents/*` | VERIFIED | `tests/browser.smoke.test.ts`, live E2E (1 page, hash match) |
| Output verification (structure + hash) | `verifyPdf`, verify step | VERIFIED | live E2E step `verify:succeeded` |
| Web search (SearXNG / APInex) | `src/browser/research.ts` | INTEGRATED | `tests/search.test.ts` (unit); live search not exercised |
| Artifact storage on filesystem | `src/workspace/workspace.ts` | VERIFIED | `tests/e2e.research.test.ts` |
| Artifact storage in Postgres | `PgArtifactStore` | VERIFIED | `tests/serverless.test.ts`, live download |
| Durable worker loop | `src/worker/main.ts` | VERIFIED | `tests/e2e.research.test.ts` |
| Bounded execution slices (serverless) | `TaskEngine.runClaimed({budgetMs})`, `claimTaskById` | VERIFIED | `tests/serverless.test.ts`, live E2E |
| Machine endpoints (`tick`, `migrate`) behind `CRON_SECRET` | `src/api/app.ts` | VERIFIED | live `/api/internal/migrate`, health |
| Audit logging | `audit_events` | INTEGRATED | written on auth/task/approval; no read API |
| Credential encryption at rest | `provider_credentials` table + `CREDENTIAL_ENCRYPTION_KEY` | BLOCKED | no AES-GCM helper implemented; do not store keys |
| Semantic memory / embeddings | keyword ranking only | NOT ADOPTED | would need an embedding provider |

## Serverless deployment (Vercel)

| Capability | Implementation | Status | Evidence |
| --- | --- | --- | --- |
| Vercel Node function for the Hono app | `api/index.ts`, `vercel.json` | VERIFIED | live `/api/health` returns 200 |
| Managed Postgres (Neon) with RLS | Neon resource + migration | VERIFIED | live `database:ok`, `schema:ok` |
| Schema migration endpoint | `POST /api/internal/migrate` | VERIFIED | applied to Neon, then verified by E2E |
| Request-driven task execution | `POST /api/tasks/:id/run` | VERIFIED | live 12/12 E2E |
| Scheduled queue drain | `/api/internal/tick` + `crons` | INTEGRATED | endpoint verified; daily cron not yet observed firing |
| Static console | `public/index.html` | VERIFIED | live `/` returns the console |
| Cross-origin mutation guard on any host | `src/api/app.ts` | VERIFIED | live 403 for foreign Origin |

## Upstream foundations

| Upstream capability | Source | Status | Note |
| --- | --- | --- | --- |
| OpenBot bot lifecycle, supervisor, Docker computers | `vendor/openbot` | VENDORED | Requires a Docker host and a long-running process; not runnable on this deployment |
| OpenBot browser profiles / sessions | `vendor/openbot` | VENDORED | Talisman uses per-run contexts; persistent profiles not adopted |
| OpenBot MCP infrastructure | `vendor/openbot/server/src/mcp*` | VENDORED | Adapter not written |
| OpenBot Composio connectors | `vendor/openbot/server/src/plugins` | VENDORED | Adapter not written |
| OpenMuse task engine, goals, monitors | `vendor/openmuse/apps/server/src/engine` | INSPECTED | Talisman's task engine is its own; goals/monitors not ported |
| OpenMuse Gmail / Calendar adapters | `vendor/openmuse/packages/integrations` | VENDORED | Needs OAuth credentials and per-tenant token storage |
| OpenMuse memory subsystem | `vendor/openmuse` | INSPECTED | Talisman uses a keyword-ranked `memories` table |
| OpenDuet web application | `vendor/openduet` | NOT ADOPTED | It is a Next.js app with its own data model; adopting it would duplicate the working console and the RLS schema |
| OpenDuet mobile application | `vendor/openduet` | NOT ADOPTED | Not deployable from this repository without a separate mobile pipeline |
| AG-UI protocol | OpenBot runtime | NOT ADOPTED | Talisman emits its own SSE; an AG-UI bridge is future work |
| CopilotKit Intelligence | — | NOT ADOPTED | No imports; provider layer is Talisman-owned |

## Why the vendored foundations are not executed

The brief asks for deep integration rather than vendoring. The honest position is
that this repository integrates the *capabilities that fit its deployment model*
(none of the three upstreams are imported at runtime), and keeps the rest as
attributed source. The reasons are structural, not cosmetic:

1. **Process model.** OpenBot's supervisor and computer service assume Docker and
   a long-lived daemon; the deployed target is a 60 s serverless function.
2. **Data model.** OpenDuet ships its own Next.js schema and auth. Replacing the
   working RLS schema and console with it would be a rewrite, not an integration,
   and would lose the tenant isolation that is currently tested.
3. **Credentials.** Gmail/Calendar and Composio need per-tenant OAuth token
   storage. Talisman's credential encryption is not implemented, so wiring them
   now would store secrets in plaintext.

Closing those three gaps is the prerequisite for the remaining upstream work, and
each is listed in `docs/SESSION-REPORT.md` as a next task.
