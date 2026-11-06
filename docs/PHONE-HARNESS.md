# Phone Harness: what we vendored and how Talisman will drive phones

Vendored at `vendor/phone-harness`, MIT, pinned to `4bebff1` (2026-11-04).
Source: https://github.com/phone-harness/phone-harness (YC F26).

**Status: vendored, not integrated.** Nothing in `src/` imports it yet. This note
records the design so the integration is built against what the code does, not
against a marketing page.

## What it is

A single flat op API over three different phone backends. One vocabulary —
`screen.capture`, `screen.text`, `input.tap`, `input.text`, `nav.home`,
`apps.launch`, `url.open`, `tree` — answers the same way whether the phone is:

| Backend | Transport | Runs where | Needs |
| --- | --- | --- | --- |
| Personal iPhone | macOS iPhone Mirroring window + Apple Vision OCR + synthetic input | User's Mac | macOS 15+, iOS 18+ paired, Accessibility + Screen Recording |
| Android on the desk | adb (USB or Wi-Fi) | User's machine | adb, USB/wireless debugging |
| Cloud iPhone | HTTPS control URL + control token | Anywhere | Phone Harness account |
| Cloud Android | adb to a hosted host:port | Machine with adb + outbound TCP | Phone Harness account |

The vocabulary is `OP_NAMES` in `src/phone_harness/transport.py`. A backend that
cannot honour an op raises `Unsupported` rather than failing, so capability
checks are reliable (`supports(op)`, `ops()`).

## The constraint that shapes the design

Talisman runs as a Node function on Vercel. The harness is Python, and the
personal-phone backends need a desktop OS with adb or a mirroring window. A
Vercel function can never drive a user's own phone directly. Two honest paths:

1. **Cloud phone (server-side).** `https://api.phone-harness.com` with a bearer
   key: `GET /me`, `POST /sessions`, `GET /sessions/:id` until `ready`, then the
   session's `control.url` + `control.token` accept `POST /op` with
   `{"op": "input.tap", "kw": {"x": 375, "y": 667}}`. This works from a function
   with plain HTTPS, which is what `setup/api.md` documents as the no-install
   path. Ops that need adb (cloud Android) are out of scope server-side.
2. **Local bridge (user's own phone).** We ship `scripts/phone-bridge.mjs`, a
   small authenticated HTTP/WebSocket server on the user's machine that shells
   out to the `phone-harness` CLI and exposes the same op vocabulary. The user
   runs it next to their phone and points Talisman at it with
   `PHONE_BRIDGE_URL` + `PHONE_BRIDGE_TOKEN` (or a tunnel). The browser never
   talks to the bridge; only the Talisman server does, and only with a token.

Both paths share one interface (`PhoneTransport`), so the agent tools and the
Live screen do not care which one is in use. There is no third path where the
server pretends a phone is connected.

## Tool surface

Agent tools, all mapped 1:1 onto ops so nothing is invented:

| Tool | Ops | Approval |
| --- | --- | --- |
| `phone_look` | `screen.capture` + `screen.text` | none (read) |
| `phone_open_app` | `apps.launch` | once per app per run |
| `phone_tap_text` / `phone_tap` | `screen.text` → `input.tap` | yes when the target is a control that submits, pays, sends or deletes |
| `phone_type` | `input.text` | yes if the field is a password or one-time-code field |
| `phone_swipe` / `phone_scroll` | `input.drag`, `input.scroll` | none (navigation) |
| `phone_home` / `phone_back` | `nav.home`, `nav.back` | none |
| `phone_read_code` | `screen.text` filtered to 4–8 digit codes | yes, and the code never enters the transcript unredacted |

Approval is not decorative: a tap that sends a message is exactly the class of
action the existing approval boundary already covers, and it reuses it rather
than adding a second gate.

## Data and security

- `devices` table: one row per connected phone, owned by a user, scoped by
  `org_id`, with the encrypted control token or bridge token in
  `provider_credentials` (same AES-GCM path as Google, provider `phone`).
- Control tokens are write-only from the API's point of view; the browser sees
  device metadata and a screen stream, never a credential.
- Screenshots contain whatever is on the phone. Retention is a policy setting on
  the device (keep for the run, keep 24h, keep none), and screenshots are not
  written to the artifact store unless a run explicitly attaches one.
- Reading 2FA codes is a high-risk tool: it is disabled by default, enabled per
  device by the owner, and every call is written to the audit log with the code
  redacted.

## Limits (from upstream, not ours to paper over)

- Unlocking an iPhone pauses mirroring; a PIN-locked Android needs the human.
- OCR reads text, not icons. Icon-only controls need a screenshot and a
  vision-capable model.
- No multi-touch, no camera, no Face ID. DRM video renders black.
- Connecting the phone is always the user's job; the product must say so plainly
  instead of showing a spinner forever.

## Test plan (written before the UI that uses it)

- A fake control server that implements `/ops` and `/op` and records calls, so
  the cloud transport is tested over real HTTP against real JSON, including
  token refresh failure, `Unsupported` ops and timeouts.
- A fake harness binary for the bridge, so the bridge's auth, op routing and
  error mapping are tested without a phone.
- One opt-in live test behind `PHONE_LIVE=1` that talks to a real cloud phone
  when a key exists; it stays skipped otherwise and is never reported as passed.

## Reserved environment names

| Name | Purpose |
| --- | --- |
| `PHONE_HARNESS_API_KEY` | Cloud account key, server-side only |
| `PHONE_HARNESS_CLOUD_API` | Optional host override (tests, self-hosted) |
| `PHONE_BRIDGE_URL` | Base URL of the local bridge |
| `PHONE_BRIDGE_TOKEN` | Bearer token the bridge requires |
| `PHONE_DEFAULT_DEVICE` | Optional device id used when a run does not name one |
