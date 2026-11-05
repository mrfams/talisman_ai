# Integration decisions

## D1 — One canonical OpenBot copy

OpenDuet vendors an older OpenBot snapshot under `openbot/` (2,336 files) that
differs from upstream `CopilotKit/openbot` (3,027 files, commit `86a0a46`). Copying
both would duplicate ~2.3k files and create two divergent computers/runtimes.

Decision: `vendor/openbot` is the canonical OpenBot. `vendor/openduet` keeps only
OpenDuet's tenant package, scripts, evals and docs. The duplicate `openbot/` tree is
not committed. Upstream tracking is recorded in `NOTICE`.

## D2 — Talisman owns a new service, not a fork of the OpenBot server

The OpenBot server is a large Bun application wired to CopilotKit runtime,
Intelligence, Better Auth and Drizzle. Rewriting it in place would have made the
first milestone (research → document) depend on all of that at once.

Decision: Talisman is a new TypeScript service (`src/`) with its own schema and
intelligence layer. OpenBot remains vendored for the computer supervisor, UI and
connectors, to be integrated behind adapters. This is deliberate duplication of
*plumbing*, not of product logic; the capability map shows what replaces what.

## D3 — npm and one package instead of a monorepo

Upstreams use Bun (OpenBot), pnpm (OpenMuse) and Bun again at OpenDuet's root.
Mixing them would add three package managers before a single test ran.

Decision: npm workspaces are unnecessary for this stage; one package with module
folders is used for Talisman code. Vendor trees keep their own manifests and are
not built by Talisman's scripts. Revisit when the OpenBot app is wired in.

## D4 — Tenant isolation enforced by Postgres, not only by queries

OpenMuse uses a single `records(owner, kind, ...)` table with a shared access key.
OpenBot relies on route predicates and ACL tables without an `org_id` everywhere.

Decision: every Talisman tenant table carries `org_id`; RLS is enabled and forced;
tenant work runs as a non-superuser role with `talisman.org_id` set per
transaction. Missing context returns zero rows and rejects writes (tested). Auth
tables are outside RLS because they are read before an org exists, and are only
touched by the auth service with explicit predicates.

Production note: the connecting role must be allowed to `SET ROLE talisman_app`
(grant membership) or the server fails closed with a policy error.

## D5 — Replace CopilotKit Intelligence completely

No `@copilotkit/*` dependency appears in Talisman's `package.json` or imports.
Conversations, messages, model routing, fallbacks, streaming, tool calls, context
and memory are Talisman's. AG-UI and MCP are protocols, not replaced; they are
vendored and can be bridged later.

## D6 — Real browser, isolated context, default-deny egress

OpenMuse's worker uses persistent Chromium and application-level network checks;
OpenBot's computer adds a Docker supervisor. Neither is a hostile-tenant boundary.

Decision for this milestone: one Playwright Chromium context per task (no shared
profile), destroyed afterwards; URL policy blocks non-http(s), credentials in
URLs, private ranges after DNS resolution, and re-checks after redirects. Private
network access is an explicit test-only flag and is rejected in production config.

## D7 — Evidence-only documents

The research handler does not let a model invent findings. Report sections are
built from text actually extracted by the browser, with source URLs. This keeps
the milestone honest without an API key and makes the output verifiable. A model
summary can be added on top later without changing the evidence path.

## D8 — Approval resume semantics

Approvals are durable rows. A handler calls `requestApproval`, which creates the
row, parks the task in `waiting_approval` and releases its lease. On resume the
handler runs again and sees the approved or denied decision. This avoids holding a
worker lease while a human decides, and makes retries idempotent. Denial fails the
task; it never silently continues.

## D9 — Worker claims at organisation scope

Tasks are claimed per organisation with a service principal in the user slot; RLS
is organisation-scoped and execution uses the task's real user id. This avoids
enumerating every user on every tick. It is O(organisations) per poll and should be
replaced by a dedicated queue when the number of organisations grows.

## D10 — Real Postgres locally and in CI, never a weaker engine

Postgres is the deployment target, and the isolation tests depend on real RLS,
roles and `SET ROLE`. PGlite was tried first but cannot host this schema under
Node 26 (the WebAssembly code space is exhausted), and its behaviour is not a
substitute for a real server. Tests and local development therefore use embedded
Postgres (`embedded-postgres`): one server per test run, one database per test,
or an external `TALISMAN_TEST_PG_URL` in CI. The development fallback is refused
when `NODE_ENV=production`.

This machine (4.1 GB RAM) ran out of memory starting Postgres during the final
verification pass; see the session report. That is an environment limit, not a
code path.

## Known limitations

- No credential encryption yet (`provider_credentials` table exists; AES-GCM helper
  is not written), and no API for provider credentials.
- Login throttling is in-memory and per-process.
- Audit rows are written but not exposed through an API; no retention job yet.
- PDF verification is structural, not a semantic check that the text is correct.
- The browser is real but runs headless Chrome on the host; no Docker/VM isolation
  is applied to the browser yet.
- Task event SSE polls the database every 750ms.
