# Deploying Talisman on Vercel

Talisman was written for a long-running Node host with a persistent disk and a
local Chrome. Vercel gives neither, so the deployment uses a small adapter layer
instead of pretending the same process model works. Everything below is the same
application code that runs locally; only the drivers change.

## What changes on a serverless host

| Concern | Long-running host | Vercel |
| --- | --- | --- |
| HTTP | `@hono/node-server` listen | `api/index.ts` Node function, all `/api/*` rewritten to it |
| Database | `DATABASE_URL`, or an embedded cluster for local dev | Managed Postgres (Neon) over TLS |
| Schema | applied on start (`TALISMAN_AUTO_MIGRATE`) | applied by `POST /api/internal/migrate` with `CRON_SECRET` |
| Task execution | `npm run worker`, a durable loop | one bounded slice per request (`POST /api/tasks/:id/run`), plus a daily cron drain |
| Artifact bytes | filesystem under `DATA_DIR` | `artifact_blobs` table in Postgres |
| Page reader | local Chrome via Playwright | HTTP reader with no JS engine, or a remote Chromium over CDP |
| Task events | SSE stream | the same endpoint with `?format=json`, polled by the console |

The selection is automatic (`TALISMAN_ARTIFACT_STORE=auto`,
`TALISMAN_BROWSER_MODE=auto`): when `VERCEL` is set, artifacts go to Postgres and
pages are read over HTTP. Both can be overridden explicitly.

## Execution model

A task is a plan of steps, and every step commits its own progress to Postgres.
A request that runs a task gets a 45 s budget (`TALISMAN_MAX_RUN_MS`). When the
budget runs out, the engine aborts the in-flight step, releases the lease and
returns the task to `queued`; the next slice resumes from the first unfinished
step. A lease prevents two slices from running the same task at once, and a
crashed invocation is recovered when its lease expires.

This means tasks survive a function timeout, a deploy and a cold start. It also
means a long job takes several requests: the console drives them while the task
panel is open, and the daily cron drains anything left behind.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Managed Postgres. Neon's pooled URL is used. |
| `SESSION_SECRET` | yes | 32+ bytes; peppers session token hashes. |
| `CREDENTIAL_ENCRYPTION_KEY` | yes to store credentials | 32-byte base64 AES key. |
| `CRON_SECRET` | recommended | Authorises `/api/internal/tick` and `/api/internal/migrate`. Unset disables both. |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` | for chat | OpenAI-compatible provider (APInex works). |
| `ANTHROPIC_API_KEY` | optional | Second provider for routing and fallback. |
| `TALISMAN_SEARCH_URL` | for URL-less research | SearXNG JSON endpoint or APInex base. |
| `BROWSER_WS_ENDPOINT` | optional | Remote Chromium over CDP; switches `auto` to real browser rendering. |
| `TALISMAN_MAX_RUN_MS` | optional | Slice budget, default 45000. Keep below the function's `maxDuration`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | for Calendar | OAuth client (type: Web application). |
| `GOOGLE_REDIRECT_URI` | optional | Defaults to `<request origin>/api/connectors/google/callback`. |
| `PHONE_HARNESS_API_KEY` | for cloud phones | Server-side key for api.phone-harness.com. |
| `PHONE_HARNESS_CLOUD_API` | optional | Host override for tests or a self-hosted instance. |
| `PHONE_BRIDGE_URL` / `PHONE_BRIDGE_TOKEN` | for your own phone | The bridge in `scripts/phone-bridge.mjs` must be reachable from Vercel over HTTPS. |
| `PHONE_DEFAULT_DEVICE` | optional | Device id used when several cloud phones are available. |

`vercel.json` sets `maxDuration: 60` and `memory: 1024` for the function, and
bundles `src/db/schema.sql` with it.

## Deploying

```bash
npx vercel link --project talisman-agent
npx vercel integration add neon --name talisman-db     # or any Postgres
npx vercel env add DATABASE_URL production             # if not provided by Neon
npx vercel deploy --prod
```

Apply the schema once per environment:

```bash
curl -X POST https://<deployment>/api/internal/migrate \
  -H "authorization: Bearer $CRON_SECRET"
```

`GET /api/health` reports `database`, `schema` and the resolved capabilities, so
a misconfigured deployment fails visibly instead of failing at signup.

## Connecting Google Calendar

1. In Google Cloud, create an OAuth client of type **Web application** and add
   `https://<deployment>/api/connectors/google/callback` as an authorised
   redirect URI.
2. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the Vercel project and
   redeploy (env changes apply to new deployments).
3. `CREDENTIAL_ENCRYPTION_KEY` must be set; without it the connector refuses to
   store tokens rather than writing them in plaintext.
4. In the console, **Connect Google Calendar**, approve the consent screen, then
   **Test connection**. That last button performs a real `calendar.list` and
   reports how many events came back.

Tokens are encrypted per user; disconnecting deletes the row. Rotating
`CREDENTIAL_ENCRYPTION_KEY` invalidates existing tokens, so users must reconnect.

## Verifying a deployment

```bash
curl -s https://<deployment>/api/health
curl -s -X POST https://<deployment>/api/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a long enough password","orgName":"Demo"}'
```

The console at `/` signs up, creates a task, drives its execution, shows step
history, approval prompts and the finished PDF.

## Limits of this deployment

- **No local browser.** The HTTP reader fetches real pages and extracts real
  text, but it does not execute JavaScript. Pages that render client-side return
  little. Point `BROWSER_WS_ENDPOINT` at a remote Chromium (Browserless,
  Browserbase, or a container you control) to restore full rendering.
- **Artifacts live in Postgres.** Fine for the PDFs this app produces (tens of
  KB); move to object storage before producing large media.
- **Cron frequency.** The Vercel Hobby plan runs crons at most once a day, which
  is why execution is also request-driven. On Pro, tighten the schedule.
- **No execution isolation beyond the function sandbox.** A remote browser or a
  computer service must provide its own isolation; do not attach one shared
  profile to many tenants.
- **Long jobs cost several invocations.** A research task reading four pages
  typically completes in one or two slices.
