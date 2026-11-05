# Foundation inventory (inspected 2026-11-05)

Method: cloned all three upstreams, read source (not only READMEs), diffed OpenBot
against the copy OpenDuet vendors, and ran file inventories. Vendored trees live in
`vendor/` and retain their licences.

| Project | Commit / version inspected | Files | Licence |
| --- | --- | --- | --- |
| OpenBot (`CopilotKit/openbot`) | `86a0a469f0204e2ead83256cad76d7411478d754` | 3,027 | MIT |
| OpenDuet (`CopilotKit/OpenDuet`) | `f52288f` | 2,365 (incl. `openbot/`) | MIT |
| OpenMuse (`CopilotKit/OpenMuse`) | `main` at clone, 2026-11-05 | 231 | MIT |

## 1. OpenBot is the actual execution platform

- OpenDuet has **no submodule**: `openbot/` is a vendored snapshot (no `.gitmodules`).
  Its `openbot/package.json` declares workspaces `app, server, worker, shared, toolkit`
  and `packageManager: bun@1.4.3`. `supervisor/` has its own package but is not listed
  in `workspaces`.
- The vendored snapshot is **not current OpenBot**: 2,336 files vs 3,027 upstream, and
  `diff -rq` shows dozens of differing/added files (agent adapters, `.github/workflows`,
  LICENSE, README, computer image). Treat OpenDuet's copy as a pinned fork snapshot, not
  as upstream tracking.
- OpenBot's own deployment image is `ghcr.io/copilotkit/openbot`; OpenDuet publishes no
  image (`vendor/openbot/docs/deployment.md`).
- Services: `server` (Hono + CopilotKit runtime), `app` (React web), `mobile`,
  `desktop` (Tauri), `worker` (routine sweep loop), `supervisor` (Docker computer
  lifecycle), `agent-computer` (browser/computer executor), and 15 `agent-*` adapters
  (ADK, AG2, Agno, Claude SDK, CrewAI, LangGraph, Mastra, Strands, Pydantic AI, ...).
- `openbot/server/src/app.ts` mounts auth, agents, approvals, audit, channels,
  computers, plugins/Composio, memory, learning, routines, host access, credentials.
- `openbot/server/drizzle/0000_schema.sql` has 30+ tables including `users`,
  `sessions`, `accounts`, `organizations` via Better Auth, `agents`, `channels`,
  `approvals` policy tables, `audit_events`, `documents`/`document_acls`, `chunks`,
  `connector_instances`, `credentials`, `mcp_servers`/`mcp_tools`, `plugin_grants`,
  `skills`, `components`. **No `org_id` column on most product tables**; isolation is
  by user/agent/workspace predicates and document ACLs, not database-enforced RLS.
- Auth is real multi-user: Better Auth 1.7.1 with Drizzle adapter, SSO, SCIM, Expo and
  Electron plugins (`server/src/auth/index.ts`). There is a documented single-user
  bypass (`OPENBOT_SINGLE_USER`) for local use.
- Approvals are a deep, tested subsystem: `approvals/policy.ts` ranks `allow <
  pre_approved < ask < hand_off`, matches rules with globs, and has non-configurable
  safety requirements for credentials, security settings and payments. Every effect
  other than a read is treated as a write unless positively classified.
- Audit: `audit_events` is append-only and redacts secrets; retention logic in
  `audit-retention.ts`.
- Worker (`worker/src/index.ts`) is only a routine sweeper: it offers due routines and
  dispatches them to the server. Durable queue code lives in
  `server/src/work/queue.ts` and `server/src/routines/`.
- Computer infrastructure: `supervisor/src/docker.ts` + `environment.ts` +
  `authorisation.ts` + `identity.ts`. The supervisor holds the Docker socket, compares
  its bearer token with `timingSafeEqual`, forwards only `EGRESS_PROXY*`,
  `COMPUTER_TOKEN`, SPIRE socket and browser mode into a computer, and can register a
  SPIFFE identity per Bot. The agent computer is a real Playwright/Chromium container.
  It is Docker isolation on a shared kernel, not a VM boundary.
- Network controls exist (`EGRESS_PROXY*`, computer policy store, browser governance)
  but must be configured; they are not on by default in every deployment.
- Tests: substantial `bun test` suites across server, supervisor, toolkit, agents;
  quality scripts (`test:ci`, sharded server tests, mutation checks).
- Dependencies of note: `@copilotkit/runtime` 1.77.0, `better-auth`, `drizzle-orm`,
  `postgres`, `@modelcontextprotocol/sdk`, `@composio/core`, `@mastra/core`,
  `playwright-core`, `dockerode`, `zod` 4.

## 2. OpenDuet is a thin product layer on OpenBot

- Root `package.json` is only `postinstall`/`start`/`stop`; the real code is the
  vendored OpenBot plus `openbot/examples/openduet` (README: "Everything that makes
  OpenDuet ... lives in one folder").
- The tenant package defines name, Bots, channels, model (`gpt-5.6-terra`) and skills.
- OpenDuet **requires CopilotKit Intelligence** for threads and memory; the server
  refuses to start without `INTELLIGENCE_API_KEY` (README, quick start).
- Adds morning brief, triage evals (`evals/triage`), Tasks/Make surfaces and
  OpenDuet-specific server routes (`server/src/openduet/*`).
- So: OpenDuet contributes a product/tenant package, evals and UX patterns. The
  platform, isolation, approvals, audit and computer infrastructure are OpenBot's.

## 3. OpenMuse is the task/lifecycle product layer

- pnpm monorepo, Node >= 22, TypeScript, Hono, `@electric-sql/pglite` + `pg`, Zod 4,
  RxJS, `@modelcontextprotocol/sdk`, `pdf-lib`, `playwright-core`, `@tanstack/ai*`.
- `apps/server`: Hono API, auth, browser service, computer service (Docker + E2B
  Desktop), engine (task worker, model execution, page diffing, finance), Google
  OAuth, JEV, search, files, workspace, rate limiting.
- `apps/worker`: separate Playwright browser worker with its own bearer token,
  persistent Chromium profiles, public-network checks and a proxy.
- `apps/computer`: opt-in Docker Linux container (read-only rootfs, all capabilities
  dropped, `network=none`, 512 MB / 1 CPU / 128 pids / 64 MB tmp, UID 1000) or an
  E2B Desktop VM.
- `apps/mobile`: Expo app with web target (chat, threads, browser console, PDF reader,
  computer workspace, desktop stream).
- `packages/domain`: task, goal, monitor, idea, memory, notification, artifact,
  evidence types plus Zod schemas. `packages/integrations`: Google, PDF, vault.
  `packages/backends/openbot.ts`: a disabled, contract-tested OpenBot HTTP adapter.
- Durability: `engine/worker.ts` implements leasing, heartbeat, pause/cancel aborts,
  max 3 in-flight tasks, 1s polling, lost-lease detection and uncertain-outcome
  handling. `engine/service.ts` has ~2,000 lines of task lifecycle, monitors, ideas,
  memories, artifacts and outcome publication.
- Storage is a generic `records(owner, kind, id, data jsonb)` table (`db.ts`) with
  owner-scoped access, not a normalised multi-tenant schema.
- **Security boundary is single-owner.** `apps/server/src/auth.ts` compares one shared
  access key and issues sessions for `owner: "local-user"`. `SECURITY.md` says so
  explicitly. Google tokens are encrypted; signed URLs are bearer credentials.
- Browser worker: application-level public-network checks, but Playwright disables
  Chromium's sandbox by default; README says this is not a hostile-tenant boundary.
- E2B Desktop: internet egress, passwordless sudo in the VM, publicly reachable ports,
  8-character VNC password in the URL. Documented as a real risk.
- Tests: ~45 `node:test` files (auth, browser, computer, engine, model, Google, PDF,
  JEV), plus a browser lifecycle suite and CI workflow.
- Licence MIT. OpenMuse's own `docs/OPENBOT-INTEGRATION.md` pins OpenBot at
  `a96d88c` and states the integration is source inspection only, not running.

## 4. Overlaps that must be resolved (not duplicated)

| Area | OpenBot | OpenMuse | Resolution for Talisman |
| --- | --- | --- | --- |
| Browser | `agent-computer` + computer policy/gateway | `apps/worker` + browser service | One `BrowserDriver`; Playwright, policy-checked, isolated context. Computer supervisor stays vendored for later. |
| Tasks | routines + durable work queue | `TaskWorker` + engine | Talisman `TaskEngine` (leases, pause/cancel, approvals, receipts) |
| Memory | `server/src/memory` + Intelligence | `memories` records | Talisman `memories` table + retrieval; no Intelligence call |
| Approvals | policy engine + approval service | actions/approvals | Talisman approval rows + engine gate; port OpenDuet policy ranking next |
| Auth | Better Auth + SSO/SCIM | single access key | Talisman own sessions + orgs/memberships + RLS |
| PDF | none (rejects PDF uploads) | `pdf-lib` import/fill | Talisman `pdf-lib` report renderer + structural verification |
| Google | Gmail/Calendar/Drive via plugins | Google OAuth + Gmail/Calendar | Vendored; port later |
| Chat runtime | CopilotKit runtime + Intelligence | `@copilotkit/runtime` + Intelligence | **Replaced** by Talisman providers/router/agent loop |
| Storage | Postgres + Drizzle, many tables | generic `records` JSONB | Talisman normalised schema + JSONB payloads |

## 5. Missing capabilities and security gaps found

1. No shared intelligence layer that owns conversations, provider routing,
   streaming, tool calls, context and memory. Both products depend on CopilotKit
   Intelligence.
2. OpenMuse is single-owner. It cannot be exposed to multiple users as-is.
3. OpenMuse browser/computer isolation is documented as not hostile-tenant safe;
   E2B adds public egress and weak VNC protection.
4. OpenBot has strong auth and approvals but no org-scoped RLS; isolation depends on
   route predicates and ACL tables.
5. OpenBot's computer boundary is Docker on a shared kernel; egress controls are
   opt-in and deployment-specific.
6. No PDF/document generation in OpenBot; no multi-user accounts in OpenMuse.
7. No unified API or UI across the three; no shared task/memory/file model.
8. OpenDuet pins an older OpenBot snapshot than upstream. Blindly merging both trees
   would duplicate ~2.3k files and conflict.

## 6. What Talisman uses today

- **OpenBot** (`vendor/openbot`): reference for auth/approval/audit/computer design,
  and the source we will wire the supervisor and UI from. Not yet executed.
- **OpenDuet** (`vendor/openduet`): tenant package, evals, product patterns. Its
  duplicated `openbot/` is deliberately not vendored twice.
- **OpenMuse** (`vendor/openmuse`): reference for task lifecycle, PDF and browser
  worker; its single-owner auth and generic `records` store are **not** reused.
- New Talisman code implements the intelligence layer, tenant model, task engine,
  browser driver, document pipeline and API. See `docs/CAPABILITY-MAP.md`.
