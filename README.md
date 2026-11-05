# Talisman

A general-purpose personal AI agent platform with strong research and document
capabilities. Talisman unifies the useful parts of **OpenBot**, **OpenDuet** and
**OpenMuse** and replaces CopilotKit Intelligence with its own intelligence layer.

This repository is an early, working foundation, not a finished product. The
inventory of the upstreams and what was reused is in
[`docs/INVENTORY.md`](docs/INVENTORY.md); what is wired today is in
[`docs/CAPABILITY-MAP.md`](docs/CAPABILITY-MAP.md).

## What works today

- Multi-user accounts: organisations, memberships, scrypt passwords, hashed
  sessions, cookie or bearer auth, login throttling.
- Postgres schema with **row-level security** on every tenant table; tenant
  transactions switch to a non-superuser role so policies actually apply.
- Talisman-owned model layer: OpenAI-compatible and Anthropic streaming, model
  routing with fallbacks, a provider-neutral tool-call agent loop, context
  budgeting and memory injection. No CopilotKit Intelligence import.
- Durable tasks: plans, steps, progress, events, pause/resume/cancel/retry,
  approvals with a default-deny gate, leases, heartbeats and receipts.
- A real browser research pipeline: policy-checked Chromium navigation, real page
  extraction, evidence-only report composition, real PDF rendering with pdf-lib,
  and structural verification (header, EOF, parse, pages, hash).
- A minimal web console at `/`.
- Unit, integration and one real-Chrome end-to-end test, plus CI.

Not yet wired: OpenBot's web/mobile apps, Docker computer supervisor, Gmail/
Calendar, MCP/Composio connectors, goals and monitors, credential encryption,
semantic memory, and AG-UI. See the capability map.

## Quick start

Requirements: Node 22+ and (for the browser worker) Google Chrome.

```bash
cp .env.example .env
# Set SESSION_SECRET (32+ chars). DATABASE_URL is optional for local dev.
# `.env` is loaded automatically by the API, worker and migrate commands.
npm install
npm run migrate        # only needed with DATABASE_URL
npm start              # API + console on http://localhost:3000
npm run worker         # in another terminal: executes queued tasks
```

Without `DATABASE_URL`, Talisman starts an embedded Postgres cluster under
`.data/postgres` on port 55432. The API and worker in separate processes share it;
production requires a real `DATABASE_URL`.

For research tasks, either put URLs in the request or set `TALISMAN_SEARCH_URL`
to a SearXNG-compatible JSON endpoint. Configure `OPENAI_API_KEY` and/or
`ANTHROPIC_API_KEY` for chat and general answers.

## First end-to-end workflow

1. Sign up in the console.
2. Create a task: `Research https://example.com/a and https://example.com/b and
   prepare a document about it.`
3. The worker plans four steps, opens each page in real Chrome, extracts evidence,
   composes a report, renders a PDF and verifies it.
4. Progress, per-step history, sources and the artifact are visible on the task.

The PDF contains the pages' real text with source URLs. If a page fails, the
failure is recorded and the run continues with the evidence it has; if no page
can be read, the task fails honestly.

## Layout

```
src/core        types, config, ids, errors, logging
src/db          schema.sql (RLS), drivers, repositories, migrations
src/auth        scrypt passwords, sessions
src/intelligence provider adapters, router, context, agent loop
src/runtime     planner, task engine, research/document handlers
src/browser     URL policy, Playwright driver, collection/search
src/documents   report composition, PDF render, verification
src/workspace   per-task workspace and artifact store
src/api         Hono app and server
src/worker      durable worker loop
public          console
tests           unit, integration, API and real-browser E2E
vendor          upstream source, unmodified, with licences
docs            inventory, capability map, decisions, security
```

## Checks

```bash
npm run typecheck
npm run test:browser      # real Chrome + PDF, no database needed
npm test                  # full suite; needs Postgres and Chrome
```

Tests use one embedded Postgres per run, or `TALISMAN_TEST_PG_URL` when an
external server is available. CI supplies a Postgres service and Chrome.

Verified on 5 November 2026: `tsc --noEmit` clean, and **19/19 tests pass** on
Node 26 with real Postgres and host Chrome, including tenant isolation, approvals,
pause/resume/cancel, API scoping and a real-browser research run producing a
verified PDF. That run used fixture pages and a mock model; live providers and
search were not exercised for lack of keys. Details and gaps are in
[`docs/SESSION-REPORT.md`](docs/SESSION-REPORT.md).

## Security posture

Talisman defaults to deny: RLS with no tenant context returns nothing; browser
URLs must be http(s), public, and optionally allowlisted; tools that require
approval are denied when no approval handler is provided; missing policies fail
closed. This is a foundation, not a hardened multi-tenant deployment. Read
[`docs/SECURITY.md`](docs/SECURITY.md) before exposing it to anyone else.

## Attribution

OpenBot, OpenDuet and OpenMuse are MIT licensed. Their notices are preserved in
`vendor/*/LICENSE` and [`NOTICE`](NOTICE). Talisman's code is MIT.
