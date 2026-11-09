# Phone companion protocol (v1)

**Status:** the backend queue, pairing, frame storage, legacy transport adapter, and the Android
companion source are implemented. A debug APK builds successfully in GitHub Actions (run
`42419256753`, release `companion-5-1`) and the published asset was downloaded and hash-checked.
The APK is installed on the owner's Android phone, and pairing, heartbeat, and device telemetry are
working. AccessibilityService action execution through the approval card has **not** yet been
verified on the physical phone; do not describe that as verified until it has.

The phone is the host. Talisman is a mailbox and planner; it never opens an inbound port on the
phone. The companion polls outbound, claims one command, executes it, and posts one result.

---

## 1. Identity and storage

IDs are text:

- device id: 32 lowercase hex characters from 16 random bytes;
- command, pairing, run, step, and approval ids: the platform's existing text ids;
- device token: `<32-hex-device-id>.<base64url-secret>` where the secret is 32 random bytes.

The server stores only `sha256("device:" + secret)` in `phone_devices.token_hash`. The plaintext
token is returned once by `POST /api/phone/pair/claim` and never listed again.

Pairing codes are 8 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, displayed as `XXXX-XXXX`,
with a 5-minute TTL and a single claim. The code is stored as
`sha256("pair:" + normalized-code)`.

Tables are defined in `src/db/schema.sql`:

- `phone_pairing_codes` and `phone_devices` are deliberately **outside RLS**: token lookup happens
  before a tenant transaction exists. Every query against them filters `org_id`/`user_id`
  explicitly.
- `phone_commands`, `phone_approvals`, and `phone_frames` carry `org_id` and `user_id` and are
  protected by the same forced RLS policy as every other tenant table.

There is no PIN, password, pattern, or lock-credential storage anywhere in the companion.

---

## 2. Pairing

### Start (browser session)

`POST /api/phone/pair/start`

```json
{ "platform": "android", "name": "Pixel 9" }
```

Response `201`:

```json
{
  "code": "7K4M-2Q9X",
  "expiresAt": "2026-11-07T12:05:00.000Z",
  "qr": "https://talisman.example/phone/pair#code=7K4M-2Q9X",
  "server": "https://talisman.example"
}
```

`qr` is an optional deep link. The fragment is not sent to the HTTP server. The Android UI currently
accepts manual code entry; scanning is not implemented yet.

### Claim (device, code is the secret)

`POST /api/phone/pair/claim`

```json
{
  "code": "7K4M-2Q9X",
  "platform": "android",
  "model": "Pixel 9",
  "os_version": "16",
  "app_version": "0.1.0",
  "capabilities": { "observe": true, "act": true, "flow": true, "apps": true, "status": true }
}
```

Response `201`:

```json
{
  "deviceId": "0123456789abcdef0123456789abcdef",
  "token": "0123456789abcdef0123456789abcdef.<secret>",
  "name": "Pixel 9",
  "platform": "android"
}
```

The claim is transactional: the code is marked claimed, the device row is created, and the token
hash is written together. A second claim gets `422`. Expiry and single use are enforced. Per-IP
rate limiting and attempt lockout are **not** implemented yet; the 5-minute TTL and single use are
the current controls.

The Android app stores the server URL and token in `EncryptedSharedPreferences` backed by the
Android Keystore (`TalismanStore`).

---

## 3. Device loop

All device routes authenticate with `Authorization: Bearer <deviceId>.<secret>` and return `401`
for a missing, revoked, or forged token.

### Poll

`POST /api/phone/agent/poll`

Long-polls up to 20 seconds at the HTTP layer (the service caps its own wait at 25 seconds), claims
one queued command atomically with `FOR UPDATE SKIP LOCKED`, and returns `204` when there is none.

```json
{
  "command": {
    "id": "cmd_...",
    "op": "observe",
    "args": { "include": "all", "screenshot": true },
    "run_id": null,
    "step_id": null,
    "approval_id": null,
    "args_hash": null,
    "expires_at": "2026-11-07T12:03:10.000Z"
  }
}
```

A command is claimable only while it is `queued` and unexpired. An expired queued command is marked
`expired` rather than delivered. Polling also touches `last_seen_at`.

### Result

`POST /api/phone/agent/result`

```json
{
  "command_id": "cmd_...",
  "status": "done",
  "result": { "ok": true, "screen": { "package": "com.whatsapp", "nodes": [] } },
  "duration_ms": 840
}
```

or

```json
{ "command_id": "cmd_...", "status": "error", "error": "secure_window" }
```

The result is accepted only for this device's claimed command. Repeating the same result is
idempotent: the response is `{ "ok": true, "updated": false, "status": "done" }` rather than an
error.

### Frame

`POST /api/phone/agent/frame`

Headers:

- `Content-Type: image/jpeg`
- `X-Talisman-Seq: 42` (non-negative safe integer)
- optional `X-Talisman-Width`, `X-Talisman-Height`

The body is at most 300 KB. The server replaces the one `phone_frames` row for the device; it does
not keep a history. The browser reads it from `GET /api/devices/:id/frame`, which responds with
`cache-control: no-store`, `x-talisman-seq`, and `x-talisman-captured-at`, or `404` when there is no
frame.

### Heartbeat

`POST /api/phone/agent/heartbeat`

```json
{
  "battery": 0.72,
  "charging": true,
  "screen": "on",
  "a11y": true,
  "locked": false,
  "warnings": [],
  "network": "wifi",
  "app_version": "0.1.0"
}
```

The values are merged into `phone_devices.diagnostics` with a timestamp. Polling already updates
presence; the Android service sends a heartbeat every 30 seconds.

---

## 4. Browser and management routes

All browser routes use the normal Talisman session.

| Route | Behaviour |
| --- | --- |
| `GET /api/devices` | paired devices via `publicDevice`, plus `legacy`, `protocol`, `minApp`, `ops`, and a hint. Secrets are never included. |
| `GET /api/devices/:id` | one tenant-scoped device |
| `DELETE /api/devices/:id` | revoke, rotate to an unissued hash, cancel queued work |
| `POST /api/devices/:id/pause` | set `paused`, cancel queued work |
| `POST /api/devices/:id/resume` | set `active`; rejects revoked devices |
| `POST /api/devices/:id/rotate` | return a new plaintext token once, invalidating the old one |
| `PATCH /api/devices/:id/settings` | replace settings JSON (16 KB limit) |
| `GET /api/devices/:id/diagnostics` | device, diagnostics, capabilities, settings |
| `GET /api/devices/:id/frame` | latest JPEG or 404 |
| `POST /api/devices/:id/op` | **read-only** manual ops: `observe`, `apps`, `status` |
| `POST /api/devices/:id/actions` | request a one-shot approval for `act`/`flow`; queues only after a human decision |
| `GET /api/phone/approvals` | list pending one-shot phone approvals |
| `POST /api/phone/approvals/:id/decision` | approve or refuse exactly one pending action |

`POST /api/devices/:id/op` exists for diagnosis. It rejects every mutating op with `403`: actions
must travel through a one-shot approval, not through a second console path. The Devices page and
chat both use `POST /api/devices/:id/actions`; the panel is not an unaudited bypass.

The legacy `POST /api/devices/op` route remains for the cloud/bridge `PhoneTransport`; it is not
used by the companion.

---

## 5. Ops and result shapes

The companion implements five ops. Coordinates are device pixels. Refs are valid only for the
observation that produced them; a new observation invalidates old refs.

### `observe`

Args: `{ "screenshot": true|false }`. `include` is accepted for compatibility but the current
Android implementation returns all accessibility nodes.

```json
{
  "ok": true,
  "screen": {
    "package": "com.whatsapp",
    "nodes": [
      {
        "ref": 3,
        "text": "Send",
        "desc": "",
        "class": "android.widget.Button",
        "bounds": { "x": 840, "y": 2100, "w": 180, "h": 96 },
        "clickable": true,
        "editable": false,
        "password": false
      }
    ],
    "secure": false
  },
  "width": 1080,
  "height": 2400,
  "data": { "package": "com.whatsapp" },
  "screenshot": { "mime": "image/jpeg", "base64": "..." }
}
```

With `screenshot: true`, the companion uploads the same JPEG to the frame endpoint and includes the
base64 in the result. Screenshots are capped at 300 KB and require Android API 30+.

### `act`

```json
{ "action": "tap_ref", "ref": 3 }
{ "action": "tap", "x": 540, "y": 1180 }
{ "action": "long_press", "ref": 3 }
{ "action": "long_press", "x": 540, "y": 1180 }
{ "action": "type", "text": "I'll be 10 minutes late", "ref": 5, "submit": true }
{ "action": "swipe", "direction": "up" }
{ "action": "swipe", "x1": 540, "y1": 1800, "x2": 540, "y2": 600 }
{ "action": "scroll", "direction": "down" }
{ "action": "global", "name": "back" }
{ "action": "launch", "package": "com.whatsapp" }
{ "action": "deep_link", "uri": "https://example.com/path" }
```

`global` accepts `back`, `home`, or `recents`. `launch` and `deep_link` are checked by
`SafetyPolicy`. `type` currently returns a `submit_not_supported` warning if `submit` is requested;
the caller must tap Send separately.

Response:

```json
{ "ok": true, "action": "tap", "result": { "ok": true } }
```

### `flow`

Args:

```json
{
  "steps": [
    { "then": { "action": "launch", "package": "com.whatsapp" } },
    {
      "wait_for": { "desc": "Search", "timeout_ms": 8000 },
      "then": { "action": "tap_text", "text": "Search" }
    },
    {
      "wait_for": { "text": "Search" },
      "then": { "action": "type", "text": "Sam" }
    },
    {
      "wait_for": { "text": "Sam" },
      "then": { "action": "tap_text", "text": "Sam" }
    },
    {
      "wait_for": { "desc": "Message" },
      "then": { "action": "type", "text": "Hello!" }
    },
    {
      "wait_for": { "desc": "Send" },
      "then": { "action": "tap_text", "text": "Send" }
    }
  ]
}
```

`wait_for` may carry `text`, `desc` (content description) or `id` (Android view id), plus an
optional `timeout_ms`. The Android translation supports:

- `launch` (`package`) and `deep_link` (`uri`), which need no wait;
- `tap_text` (`text`), which waits for the anchor and then taps the requested label;
- `tap` (`x`, `y`), which taps exact coordinates after the anchor appears;
- `type` (`text`), which focuses the anchor and types into the visible field;
- `scroll` (`direction`: `up`/`down`);
- `global` (`back`/`home`/`recents`) and `none` (wait-only verification).

Unsupported steps fail with `unsupported_step`. The first non-optional failure stops the flow,
and the result lists each step's outcome so the caller can show a checklist and report exactly
where it stopped.

### `apps`

`{ "include_system": false }` returns launchable packages and labels, excluding the local
`SafetyPolicy` denylist. System apps are omitted unless `include_system` is true or the package is
the Settings app.

### `status`

Returns `ok`, `app_version`, `protocol`, battery, charging, screen, locked, a11y, model,
OS version, and AAPM where available. A partial snapshot is still returned if an Android API is
unavailable.

### Stable error codes

`locked`, `screen_off`, `secure_window`, `a11y_off`, `denied_package`, `ref_stale`,
`invalid_action`, `invalid_flow`, `unsupported_step`, `screenshot_failed`, `screenshot_too_large`,
`approval_required`, `approval_mismatch`, `unsupported`, `internal`.

---

## 6. Safety policy

The Android companion enforces, before executing an op:

- a hard package denylist for banking, password managers, authenticators, and system settings-like
  surfaces; `SafetyPolicy.isDenied` is used by both `apps` and each action;
- no operation on a secure/password window; the result is `secure_window`, and screenshots are not
  taken;
- no auto-unlock: a locked phone returns `locked`; the owner must unlock it;
- no stored lock credential and no PIN/password UI;
- deep links must pass `SafetyPolicy.requireSafeUri`;
- loopback-only local bridge at `127.0.0.1:7333`, guarded by an encrypted local token; the bridge is
  not exposed on the LAN and its notification no longer prints the token or URL.

Phone actions are approval-bound end to end:

- `phone_tap_text`, `phone_type`, `phone_open_app`, and `phone_home` in chat do not execute. They
  create a durable `phone_approvals` row containing the exact `act`/`flow` args and their hash.
- The Devices page's Phone actions panel uses the same request endpoint. **Allow once** queues one
  command; **Refuse** queues nothing.
- Approval rows are one-shot, expiring, tenant-scoped, and RLS-protected. Only the owning user can
  decide them.
- When approved, the server queues the command with `approval_id` and `args_hash`. The Android
  verifier refuses `act` and `flow` unless **both** are present and the args still hash to the
  approved value. Missing or mismatched values return `approval_required` or `approval_mismatch`.
- Read-only `observe`, `apps`, and `status` remain unapproved, but they cannot mutate the phone.

The approval card shows a short summary. The binding is the argument hash checked on the phone, so
changing the arguments after approval is rejected.

---

## 7. Versioning and tests

`GET /api/phone/agent/version` returns:

```json
{ "protocol": 1, "min_app": "0.1.0" }
```

The companion sends `X-Talisman-App` and `X-Talisman-Protocol` on its JSON requests. Protocol
changes are additive; breaking changes should use a new path and keep the previous version for one
release.

Verified on 8 November 2026:

- server `tsc --noEmit`: pass;
- app `tsc -p app/tsconfig.json --noEmit`: pass;
- `tests/phone-queue.test.ts`: 5/5 pass — single-use/tenant-scoped pairing and hashed tokens,
  atomic claim/idempotent result/tenant-scoped frames, pause/rotate/revoke, expired-command plus
  canonical-hash checks, and request → approve → claim with `approval_id`/`args_hash`, cross-tenant
  refusal, and deny-never-queues;
- `tests/phone.test.ts`: 4/4 pass — connector transports and phone tools create approval requests
  instead of sending taps directly;
- GitHub Actions `Android companion APK` run `42419256753`: success; the APK is 4,462,075 bytes
  with SHA-256 `95aa03f89254b77e1861beb7e40609dcafd342c4260ec5e9ba0e7f68a45fa382`, and the downloaded
  release asset matches that digest;
- `CanonicalJson` on Android has a matching Node test only for the Node implementation; a JVM/Node
  cross-check is still pending.

Not verified:

- a live AccessibilityService action from the approval card on the physical phone;
- a real screenshot upload and a live model-driven phone action;
- frame retention/redaction and per-IP pairing rate limiting (not implemented).
