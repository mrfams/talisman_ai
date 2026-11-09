# Talisman

A general-purpose personal AI agent platform with strong research and document
capabilities. Talisman keeps its own intelligence layer (no CopilotKit
Intelligence) and runs the same code on a long-lived Node host or as a serverless
function on Vercel.

**Live deployment: <https://talisman-agent.vercel.app>** — sign up and hand the
agent a job: chat streams, runs are visible step by step, and the files it
produces land in the artifact library.

Evidence and status live in [`docs/CAPABILITY-MAP.md`](docs/CAPABILITY-MAP.md);
the upstream inventory is in [`docs/INVENTORY.md`](docs/INVENTORY.md); decisions are
in [`docs/DECISIONS.md`](docs/DECISIONS.md); the security boundary is in
[`docs/SECURITY.md`](docs/SECURITY.md); serverless operation is in
[`docs/DEPLOY-VERCEL.md`](docs/DEPLOY-VERCEL.md).

## What works today

- Multi-user accounts: organisations, memberships, scrypt passwords, hashed
  sessions, cookie or bearer auth, login throttling.
- Postgres schema with **row-level security** on every tenant table; tenant
  transactions switch to a non-superuser role so policies actually apply, and the
  migration grants that role so this also works on a managed Postgres where the
  owner is not a superuser.
- Talisman-owned model layer: OpenAI-compatible, Gemini and Anthropic streaming,
  model routing with fallbacks, a provider-neutral tool-call agent loop, context
  budgeting and memory injection.
- Durable tasks: plans, steps, progress, events, pause/resume/cancel/retry,
  approvals with a default-deny gate, leases, heartbeats and receipts.
- A real research pipeline: policy-checked page reading, real page extraction,
  evidence-only report composition, real PDF rendering, and structural
  verification (header, EOF, parse, pages, hash).
- Two page readers: local Chromium via Playwright, or a dependency-free HTTP
  reader for hosts where a browser cannot run. A remote Chromium can be attached
  over CDP.
- Two artifact backends: filesystem for long-running hosts, Postgres for
  serverless hosts.
- Encrypted connector credentials: AES-256-GCM at rest, with the organisation,
  provider and owner bound into the ciphertext so a row copied to another tenant
  cannot decrypt.
- A Google Calendar connector: real OAuth with refresh tokens, per-user encrypted
  tokens, `calendar_list_events` and `calendar_create_event` tools, and an
  approval gate on anything that writes to the user's calendar.
- A real application at `/`: Today, streaming Chat, Runs and run detail,
  Artifacts, Approvals, Schedules, Connectors, Devices, Activity, Team and Settings,
  in light and dark themes on desktop and mobile.
- Recurring schedules: an interval or a daily wall-clock time in any IANA timezone.
  Due schedules become ordinary durable runs and are claimed atomically, so two
  overlapping cron invocations cannot double-run one schedule. If the previous
  run is still active, the occurrence is skipped and advanced instead of piling
  up a second run. A long-running host uses `npm run worker`; the Vercel
  deployment has a 15-minute Vercel Schedule fallback and
  `.github/workflows/scheduler.yml` calls the authenticated tick every five
  minutes (Vercel Hobby cannot run legacy Cron Jobs more than once per day).
- A notification inbox for finished runs, failures and pending approvals, with an
  unread badge in the top bar.
- Semantic memory: Gemini embeddings are stored with each memory and recall ranks
  by cosine similarity; older memories are lazily backfilled and keyword overlap
  remains the fallback when no embedding provider is configured. A persistent
  profile carries the user's name, timezone, locale and preferences into chat.
- Phone-hosted Android companion (forked from Claw Use, MIT): pair a sideloaded
  companion, queue `observe`/`act`/`flow`/`apps`/`status` commands, inspect the
  latest JPEG frame, pause or revoke a device, and keep the old Phone Harness
  cloud/bridge transport as a compatibility adapter. A `phone_plan` chat tool
  submits up to six guarded steps under one approval; each step waits for expected
  text and the flow stops instead of tapping a changed screen. Both browser and
  chat actions are bound to the exact argument hash. See
  [`docs/PHONE-COMPANION-PROTOCOL.md`](docs/PHONE-COMPANION-PROTOCOL.md). Download
  the latest debug APK from [Releases](https://github.com/mrfams/talisman_ai/releases).
- Unit/integration tests, a real-Chrome end-to-end test, a live deployment check,
  and CI.

Still not wired: OpenBot's Docker computers and supervisor, Gmail, MCP/Composio
connectors, goals and monitors, and AG-UI. The phone companion is not
production-ready yet: a debug APK builds in CI, but physical execution has not
been exercised on a real phone, and the on-device flow executor currently
supports taps, waits and navigation rather than typing. See the protocol document
for the exact boundary.

## Two ways to run it

### Long-running host

```bash
cp .env.example .env      # set SESSION_SECRET (32+ chars)
npm install
npm run migrate           # only needed with DATABASE_URL
npm start                 # API + console on http://localhost:3000
npm run worker            # in another terminal: executes queued tasks
```

Without `DATABASE_URL`, Talisman starts an embedded Postgres cluster under
`.data/postgres` on port 55432. Production requires a real `DATABASE_URL`.

### Serverless (Vercel)

The deployed build uses a Node function, managed Postgres (Neon), artifacts in
Postgres and a bounded execution slice per request. See
[`docs/DEPLOY-VERCEL.md`](docs/DEPLOY-VERCEL.md) for the full mapping, the
environment table and the limits. In short:

```bash
npx vercel link --project talisman-agent
npx vercel integration add neon --name talisman-db
npx vercel deploy --prod
curl -X POST https://<deployment>/api/internal/migrate -H "authorization: Bearer $CRON_SECRET"
```

A task is a plan of steps, each of which commits its own progress. `POST
/api/tasks/:id/run` executes one slice with a 45 s budget and hands the task back
when time runs out, so a function timeout, deploy or cold start never loses work.
`GET /api/health` reports `database`, `schema` and the resolved capabilities.

## First end-to-end workflow

1. Sign up in the console.
2. Create a task: `Research https://example.com and
   https://www.iana.org/help/example-domains and prepare a document about
   reserved example domains.`
3. The worker or the request-driven executor plans four steps, reads each page,
   extracts evidence, composes a report, renders a PDF and verifies it.
4. Progress, per-step history, sources and the artifact are visible on the task.

The PDF contains the pages' real text with source URLs. If a page fails, the
failure is recorded and the run continues with the evidence it has; if no page
can be read, the task fails honestly.

## Layout

```
src/core        types, config, ids, errors, logging
src/db          schema.sql (RLS), drivers, repositories, migrations
src/app         runtime assembly shared by every entry point
src/auth        scrypt passwords, sessions
src/intelligence provider adapters, router, context, agent loop
src/runtime     planner, task engine, research/document handlers
src/browser     URL policy, Playwright driver, HTTP reader, collection/search
src/documents   report composition, PDF render, verification
src/workspace   per-task workspace, filesystem and Postgres artifact stores
src/api         Hono app and server
src/worker      durable worker loop for long-running hosts
app             React application (Vite), built to app/dist
api             Vercel serverless entry point
scripts         live deployment check, phone bridge, test Postgres helper
tests           unit, integration, API and real-browser E2E
vendor          upstream source, unmodified, with licences
docs            capability matrix, inventory, decisions, security, deployment
```

## Checks

```bash
npm run typecheck        # tsc --noEmit (server)
npm run typecheck:app    # tsc -p app/tsconfig.json
npm run build:app        # vite build -> app/dist
npm run test:unit        # 31 unit/integration tests; needs Postgres
npm run test:browser     # real Chrome + PDF, no database needed
npm run test:e2e         # research task through the durable engine
BASE=https://talisman-agent.vercel.app node scripts/e2e-live.mjs
```

Verified on 6 November 2026:

- `tsc --noEmit` and `tsc -p app/tsconfig.json` clean; `vite build` produces
  114 KB gzip JS and 5.5 KB gzip CSS.
- **31 unit and integration tests pass**: auth (4), tenant isolation (3), task
  lifecycle and retries (5), serverless slices and Postgres artifacts (4),
  credential encryption and the Google Calendar connector (5), phone transport
  and tools (4), intelligence (5), API (1). The combined run under
  `--test-force-exit` can report a file-level teardown error on this
  memory-constrained machine; every file passes when the runner is allowed to
  exit normally.
- **21/21 live checks pass** against the deployment: health, anonymous
  rejection, signup, cross-origin mutation refused, task created, task
  succeeded, all four steps succeeded, PDF downloaded and parsed (1 page, hash
  matches the stored digest), cross-tenant task and artifact access refused,
  finished task not re-executed, connector encryption enabled, an unconnected
  connector refusing to execute, the artifact library, the approvals inbox, the
  audit log, the team list, the phone registry answering honestly, and client
  routes serving the application shell. Run with `node scripts/e2e-live.mjs`.
- A real-Chrome run and a research task through the durable engine passed in the
  previous session (`tests/browser.smoke.test.ts`, `tests/e2e.research.test.ts`)
  and were not re-run here.

The live run used real public pages through the HTTP reader and the APInex free
model tier. It did not exercise a JavaScript-rendered page, a remote CDP browser,
live web search, a real Google account, or a real phone. The Calendar connector
is verified end to end against a fake Google OAuth and Calendar server; a real
Google call needs your own OAuth client (`GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET`) and one consent click. Phone control is verified against
a fake control service and a fake bridge; a real phone needs
`PHONE_HARNESS_API_KEY`, or the bridge running next to your own device. The
Android companion backend has its own four integration tests and its debug APK
builds successfully in CI (release `companion-5-1`); a real phone run is still
unverified. This machine itself has no Android SDK/JDK 17 and under 1 GB free.

## Attribution

OpenBot, OpenDuet and OpenMuse are MIT licensed. Their notices are preserved in
`vendor/*/LICENSE` and [`NOTICE`](NOTICE). Talisman's code is MIT.
