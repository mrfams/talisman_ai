# Capability map

Status values: **Working** = implemented and covered by a test in this repo;
**Vendored** = source present, not yet wired or executed; **Pending** = not built.

| Talisman capability | Source of implementation | Status |
| --- | --- | --- |
| Conversations and message state | `src/db/schema.sql`, `src/api/app.ts` | Working |
| Model/provider abstraction | `src/intelligence/providers/{openai,anthropic,mock}.ts` | Working (OpenAI-compatible + Anthropic + test double) |
| Model selection and fallbacks | `src/intelligence/router.ts`, `factory.ts` | Working |
| Streaming | provider SSE parsers, `POST /api/conversations/:id/messages` | Working |
| Tool-call orchestration | `src/intelligence/agent.ts` | Working (approval gate, default deny) |
| Context management | `src/intelligence/context.ts` | Working |
| Memory integration | `memories` table, `selectMemories`, `remember` tool | Working (keyword ranking; embeddings pending) |
| Task-to-conversation coordination | `tasks.conversation_id`, `create_task` tool | Working |
| Task lifecycle (plan, steps, progress, history) | `src/runtime/engine.ts`, `planner.ts` | Working |
| Pause / resume / cancel / retry | engine + `/api/tasks/:id/*` | Working |
| Human approvals | `approvals` table + engine gate + decision API | Working |
| Execution receipts | `task_events`, step `output`, audit rows | Working |
| Durable worker | `src/worker/main.ts`, leases and heartbeats | Working (single-process loop) |
| Browser automation | `src/browser/playwright.ts` (real Chrome) | Working |
| Browser egress policy / SSRF defence | `src/browser/url-policy.ts` | Working (allowlist, private-range DNS checks, redirect re-check) |
| Isolated browser profiles | one context per task, destroyed at end | Working (per-user persistent profiles pending) |
| Computer / Docker execution | `vendor/openbot/supervisor`, `agent-computer` | Vendored |
| Workspace filesystem isolation | `src/workspace/workspace.ts` | Working (path traversal guard, per-task root) |
| Document/PDF generation | `src/documents/{report,pdf}.ts` | Working |
| Output verification | `verifyPdf`, verify step, artifact hash | Working (structural, not semantic) |
| Web search | `src/browser/research.ts` (SearXNG JSON) | Working (needs `TALISMAN_SEARCH_URL`) |
| Google Gmail/Calendar | `vendor/openmuse/packages/integrations/google.ts`, OpenBot plugins | Vendored, not ported |
| Goals and recurring monitors | `vendor/openmuse/apps/server/src/engine` | Vendored, not ported |
| MCP tools | OpenBot `mcp_servers`/`mcp_tools`, OpenMuse MCP client | Vendored, not ported |
| Composio connectors | `vendor/openbot/server/src/plugins` | Vendored, not ported |
| AG-UI protocol | OpenBot runtime + agent adapters | Vendored; Talisman emits its own SSE, AG-UI bridge pending |
| Multi-user auth | `src/auth/*` (scrypt, hashed sessions, orgs, memberships) | Working |
| Tenant isolation | Postgres RLS + `SET LOCAL ROLE` + per-user predicates | Working (tested) |
| Credential encryption | schema + AES-GCM helper pending | Pending |
| Audit log | `audit_events` + writes on auth/task/approval | Working (API not exposed) |
| Rate limiting | login throttle | Working (in-memory, single process) |
| Resource limits | worker concurrency, browser timeouts, artifact caps | Partial |
| Web UI | `public/index.html` console | Minimal; upstream OpenBot app is vendored |
| Mobile app | `vendor/openmuse/apps/mobile`, `vendor/openbot/mobile` | Vendored |
| CI | `.github/workflows/ci.yml` | Working |
| CopilotKit Intelligence | removed | No imports; guarded by design, not by a runtime flag |

## Specialist agents

| Specialist | Implementation today |
| --- | --- |
| Research | `research.collect` + `research.synthesize` handlers |
| Documents | `document.render` + `verify` handlers |
| Coding | Not yet: OpenBot agent-computer/shell is vendored; needs a workspace/exec provider |
| Browser/computer | Browser working; Docker computer pending |
| General chat | `llm.answer` + chat endpoint |
