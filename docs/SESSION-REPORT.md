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

## Incomplete / not verified

- **No live model or search keys were available.** Chat, `llm.answer` and SearX
  search were exercised only through mocks/fixtures, not a real provider.
- The E2E pages are local fixtures; no live internet research was run.
- OpenBot web/mobile apps, Docker computer, Gmail/Calendar, MCP/Composio, goals and
  monitors, credential encryption, semantic memory and AG-UI are vendored or
  pending, not wired.
- Rate limiting is in-process; the audit API is not exposed; browser profiles are
  per task, not per user.
- This is a single-tenant-per-process worker loop, not a hardened production
  deployment. Read `docs/SECURITY.md` before exposing it.

## Blockers

- No `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` or `TALISMAN_SEARCH_URL`.
- The machine is memory-constrained (3.8 GB); concurrent Postgres clusters are not
  viable, hence serial tests and a shared server.
- No Docker on this host, so computer execution could not be exercised.
- Node 22 was unavailable locally; tests ran on Node 26. CI targets Node 22.

## Exact next task

Set one real model key and a SearX endpoint, run a live research task against
public pages, and fix the first real provider/search failure. Before storing real
credentials, add encryption at rest for the credentials table.
