# Session report — 5–6 November 2026

## Milestone 2 — production deployment (6 November 2026)

Objective: make the working implementation deployable and testable by a real
user on Vercel, without weakening the isolation that already worked.

### What was integrated

| Area | Change | Evidence |
| --- | --- | --- |
| Serverless entry | `api/index.ts` (Hono via `getRequestListener`), `vercel.json` rewrites, `maxDuration` 60, schema bundled | live `/api/health` 200 |
| Managed Postgres | Neon resource; migration grant so `SET ROLE talisman_app` works where the owner is not a superuser | live `database:ok`, `schema:ok` |
| Artifact backend | `PgArtifactStore` + `artifact_blobs` under RLS; filesystem store kept for long-running hosts | `tests/serverless.test.ts`, live PDF download |
| Execution model | `claimTaskById`, bounded slices (`budgetMs`), lease release on timeout, `POST /api/tasks/:id/run` | `tests/serverless.test.ts`, live E2E |
| Machine endpoints | `/api/internal/tick` and `/api/internal/migrate`, timing-safe `CRON_SECRET`, disabled when unset | live migrate, then E2E |
| Page reader | `HttpBrowser` (no JS engine) plus CDP attach for `PlaywrightBrowser` | `tests/serverless.test.ts`, live E2E |
| Workspace | explicit non-persistent mode instead of a failing `mkdir /var/task/.data` | live E2E (first run failed here, then passed) |
| Origin guard | compares `Origin` to the serving host instead of a fixed `PUBLIC_URL` | live 403 for a foreign origin |
| Console | capability banner, JSON event polling, drives execution slices | live use |
| Concurrency fix | task detail reads are sequential on one connection (pg 9 removes overlapping queries) | `tests/api.test.ts` |

### What works

A new user can sign up on the deployment, create a research task with real URLs,
watch it execute, and download a verified PDF. Tasks survive function timeouts
and cold starts because each step commits progress and the lease is released.
Tenant isolation is enforced by RLS and by per-user predicates; both were
exercised live against a second account.

### Tests actually run

```
npx tsc --noEmit                                     exit 0
npx tsx --test --test-concurrency=1 <6 unit files>   22/22 pass
node scripts/e2e-live.mjs                            12/12 pass (live)
```

The first live run failed at `research.synthesize` with
`ENOENT: mkdir '/var/task/.data'`; that was a real defect in the serverless path
and is fixed by the explicit non-persistent workspace. The second live run
reported a false failure in the PDF check because the script scanned raw bytes
for page markers while pdf-lib compresses object streams; the check now parses
the document and compares the served hash.

### Still disconnected or unverified

- A JavaScript-rendered page and a remote CDP browser were not exercised.
- Live web search was not exercised (seed URLs were supplied instead).
- The daily cron drain is configured but has not been observed firing; execution
  is driven by requests.
- Credential encryption, Gmail/Calendar, MCP/Composio and Docker computers remain
  unimplemented or vendored (`docs/CAPABILITY-MAP.md`).
- There are no per-tenant quotas: an account can spend the provider balance.

### Next tasks

1. Implement the AES-GCM credential helper so provider/integration credentials
   can be stored per tenant, which unblocks Gmail and Calendar.
2. Point `BROWSER_WS_ENDPOINT` at a real remote Chromium and re-run the research
   task against a JS-rendered page.
3. Add per-tenant token and task quotas, and make the login throttle shared.
4. Wire one upstream connector end to end (start with Google Calendar) and mark
   it VERIFIED only after a real call returns real data.

---

# Session report — 5 November 2026

## Objective

Turn the OpenBot / OpenDuet / OpenMuse foundations into one Talisman platform with
its own intelligence layer, and deliver a working milestone: a user asks Talisman
to research a subject in a real browser and receives a verified document, with
task progress and history.

## Inspected and integrated

- **OpenBot** (`86a0a469…`, 3,027 files, MIT) is vendored once at `vendor/openbot`.
  OpenDuet's older, divergent vendored copy was deliberately not duplicated.
- **OpenMuse** is vendored in full at `vendor/openmuse`.
- **OpenDuet** tenant package, scripts, evals and docs are vendored at
  `vendor/openduet`; its duplicated `openbot/` tree is not.
- Licences and attribution are preserved in `vendor/*/LICENSE`, `NOTICE` and
  `LICENSE`.
- The detailed reuse evidence is in `docs/INVENTORY.md`; decisions are in
  `docs/DECISIONS.md`; the security boundary is in `docs/SECURITY.md`.

Reused concepts and code patterns: OpenMuse's durable task/step/approval model and
provider abstraction, OpenBot's browser/workspace and tool surface, and OpenDuet's
tenant and credential model. Talisman code itself is new TypeScript in `src/`; no
CopilotKit packages or imports remain.

## Delivered

| Area | Files |
| --- | --- |
| Config, ids, errors, logging | `src/core/*` |
| Postgres schema, RLS, repos, migrations | `src/db/{schema.sql,database,migrate,repos,runtime}.ts` |
| Auth: scrypt, sessions, throttling | `src/auth/*` |
| Intelligence: OpenAI-compatible, Anthropic, router, context, agent, mock | `src/intelligence/*` |
| Durable task engine, planner, handlers | `src/runtime/*` |
| Browser policy, Playwright driver, collection/search | `src/browser/*` |
| Evidence report, PDF render and verification | `src/documents/*`, `src/workspace/*` |
| HTTP API, SSE, console | `src/api/*`, `public/index.html` |
| Worker loop | `src/worker/main.ts` |
| Tests, CI, local Postgres helper | `tests/*`, `.github/workflows/ci.yml`, `scripts/test-pg.mjs` |

No external services were added. Postgres and Chrome are the only runtime
dependencies; model providers and search are configuration.

## Tests actually run

Environment: Windows, Node 26.3.0, one shared embedded Postgres on
`127.0.0.1:55433`, host Chrome
`C:/Program Files/Google/Chrome/Application/chrome.exe`.

```bash
npx tsc --noEmit                                   # exit 0
TALISMAN_TEST_PG_URL=… CHROME_PATH=… npx tsx --test --test-concurrency=1 tests/*.test.ts
```

Result: **19 tests, 19 passed, 0 failed** (59.4 s). Individually verified:

- tenant isolation, no-tenant denial, per-owner conversation scoping — 3/3 with
  real Postgres RLS and the non-superuser `talisman_app` role;
- auth: hashing, signup/login/session/logout, short-password rejection — 4/4;
- task engine: approval wait + resume, pause/resume, cancel, retry exhaustion,
  requeue backoff — 5/5;
- API: signup, task creation, progress events, artifact scoping — 1/1;
- intelligence: streaming, tool calls, fallback/allowlist, approval default-deny,
  context/memory — 5/5;
- real Chrome page read + evidence report + structurally verified PDF — 1/1
  (`tests/browser.smoke.test.ts`, runs without a database);
- end-to-end research task through the durable engine, real Chrome, two fixture
  pages, artifact retrieval and PDF verification — 1/1
  (`tests/e2e.research.test.ts`).

Earlier attempts with PGlite failed under Node 26 (WebAssembly code space) and
per-file embedded clusters failed on this 3.8 GB machine (shared-memory /
`VirtualAlloc` exhaustion, orphaned `postgres.exe` processes). The final runs used
a single shared Postgres and passed. This is a local resource limit, not a code
defect.

## What runs

- `npm start` serves the API and console; `npm run worker` executes queued tasks.
- Signup/login, conversations with streaming, task creation, progress SSE, pause,
  resume, cancel, approvals, artifacts and memories are wired.
- Research tasks open real pages, extract text, write evidence-only reports and
  render verified PDFs.
- RLS is enforced by role switching and tenant settings, and fails closed.

## Live provider check — 6 November 2026

APInex (`https://api.apinex.bond/v1`) is configured from `.env`.
`GET /v1/models` returned 200 with 42 model ids. The account is on the free plan
(15 RPM) with a $0 balance: paid models such as `gpt-6.1-sol` returned 402
insufficient balance. `free/gpt-6-luna` streamed `TALISMAN_OK` through Talisman's
router and emitted a valid `create_task` tool call; `free/gemini-3.8-flash` is the
configured fallback. This verifies live streaming, auth and tool calling, not a
full agent task.

## Incomplete / not verified

- Live web search is unverified (`TALISMAN_SEARCH_URL` is unset); only free-tier
  models are usable until the APInex balance is topped up.
- The E2E pages are local fixtures; no live internet research was run.
- OpenBot web/mobile apps, Docker computer, Gmail/Calendar, MCP/Composio, goals and
  monitors, credential encryption, semantic memory and AG-UI are vendored or
  pending, not wired.
- Rate limiting is in-process; the audit API is not exposed; browser profiles are
  per task, not per user.
- This is a single-tenant-per-process worker loop, not a hardened production
  deployment. Read `docs/SECURITY.md` before exposing it.

## Blockers

- Paid APInex models need a balance top-up; only free-tier models work today.
- No `TALISMAN_SEARCH_URL` is configured yet.
- The machine is memory-constrained (3.8 GB); concurrent Postgres clusters are not
  viable, hence serial tests and a shared server.
- No Docker on this host, so computer execution could not be exercised.
- Node 22 was unavailable locally; tests ran on Node 26. CI targets Node 22.

## Exact next task

Keep the APInex free model (or top up for a paid one), set `TALISMAN_SEARCH_URL`,
run a live research task against public pages, and fix the first real
provider/search failure. Before storing real credentials in the database, add
encryption at rest for the credentials table.
