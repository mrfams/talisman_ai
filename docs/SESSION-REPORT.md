# Session report — 5–6 November 2026

## Milestone 4 — a real application, and phones (6 November 2026)

Objective: replace a 395-line single-page console with a shippable application,
and add the phone harness the product needs.

### The interface

| Area | What shipped |
| --- | --- |
| Stack | React 19, Vite, TypeScript, React Router, TanStack Query, Motion, lucide; hand-written CSS tokens instead of a component library skin |
| Design | Ink/paper themes, periwinkle→mint accent, Instrument Sans + JetBrains Mono self-hosted (30 KB + 40 KB), one dither signature, 120/180/260 ms motion |
| Shell | Rail + mobile tabs, ⌘K palette, theme switch, degraded-runtime awareness |
| Pages | Sign in/up, Today, Chat (SSE), Runs + run detail, Artifacts, Approvals, Connectors, Devices, Activity, Team, Settings, 404 |
| Serving | Vercel builds `app/` to `app/dist`; SPA rewrite for client routes; `/api/*` unchanged |

Measured: `app/dist/assets/index-*.js` **114 KB gzip**, CSS **5.5 KB gzip**, build 1.6 s.

### Backend added for those pages

`GET /api/artifacts`, `/api/approvals`, `/api/activity` (owner/admin only),
`/api/team`, `/api/devices`, `POST /api/devices/op`. Every query runs inside the
existing tenant transaction, so RLS still applies to the new read models.

### Phones

Phone Harness (MIT, `vendor/phone-harness`, pinned `4bebff1`) is vendored whole
(80 tracked files), credited in `NOTICE`, and designed in `docs/PHONE-HARNESS.md`.
`CloudPhone` speaks the documented `/me` → `POST /sessions` → `control.url/op` flow;
`BridgePhone` speaks to `scripts/phone-bridge.mjs`, which shells to the CLI on the
machine that can actually see the phone. Five agent tools map 1:1 to harness ops;
four of them require approval.

### Tests actually run

```
npx tsc --noEmit                                   exit 0
npx tsc -p app/tsconfig.json                       exit 0
npm run build:app                                  exit 0
31 unit/integration tests                          30 pass
```

The one failure is the known `--test-force-exit` teardown artifact on
`tests/intelligence.test.ts`, which passes 5/5 alone. `tests/phone.test.ts` is 4/4:
cloud session start + control-token routing + screenshot, rejected key, bridge
health/op, tool approval flags and tap-by-label. All against fake HTTP services.

### Not verified

- **No real phone.** No cloud key and no bridge in this environment, so the live
deployment reports `configured:false`. The ops are exercised against a fake
control service, not a device.
- Invitations still need an email sender; the Team page says so instead of
pretending.
- Password reset is not built yet.

---

## Milestone 3 — credential encryption and Google Calendar (6 November 2026)

Objective: store connector credentials safely, then wire one real external
connector end to end.

### What was integrated

| Area | Change | Evidence |
| --- | --- | --- |
| Encryption at rest | `src/security/secrets.ts`: AES-256-GCM, random 96-bit IV, AAD binding org + provider + user, base64/hex 32-byte keys | `tests/connectors.test.ts` |
| Encrypted store | `src/connectors/store.ts` over the existing `provider_credentials` table and RLS | `tests/connectors.test.ts` (per-user isolation, ciphertext has no plaintext) |
| OAuth | `src/connectors/google.ts`: authorise URL, code exchange, refresh with rotation preserved, refresh-on-401 retry | `tests/connectors.test.ts` |
| OAuth state | `src/connectors/oauth-state.ts`: HMAC-signed tenant/user/redirect/expiry, no server-side session needed | forged state → 403 |
| Tools | `calendar_list_events` (read) and `calendar_create_event` (approval required) | `tests/connectors.test.ts`, agent approval test |
| API | `GET /api/connectors`, `GET .../authorize`, `GET .../callback`, `POST .../verify`, `DELETE ...` | full connect/verify/disconnect flow in tests |
| Console | connector panel with connect, test and disconnect | code |

### Reuse from upstream

The Calendar request shapes, endpoints and calendar-id validation follow
`vendor/openmuse/packages/integrations/src/google.ts`. OAuth, token refresh,
encryption and the approval gate are Talisman's, because OpenMuse's adapter
assumes a single-owner deployment with an already-authorised token.

### Tests actually run

```
npx tsc --noEmit                                    exit 0
npx tsx --test --test-concurrency=1 <7 files>       26/27 pass
```

The one reported failure is the same file-level teardown artifact seen in the
previous milestone: `tests/intelligence.test.ts` passes 5/5 when run alone. The
new connector file passes 5/5, including a complete OAuth callback → encrypted
token → `calendar.list` → disconnect cycle against a fake Google server.

### Not verified

- **No real Google call.** This deployment has no OAuth client, so the connector
  reports `not configured` in production. The code path is exercised against a
  fake Google backend; the real consent screen and a real `calendar.list` need
  the owner's client id and secret.
- Gmail, Composio and MCP remain absent.
- Key rotation has no re-encryption job.

### Next tasks

1. Set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, click through consent and mark
   the connector VERIFIED against real Google.
2. Add the same encrypted-token plumbing to Gmail, then MCP servers.
3. Add a key-rotation job that re-wraps stored ciphertexts.

---

# Session report — 5 November 2026

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
