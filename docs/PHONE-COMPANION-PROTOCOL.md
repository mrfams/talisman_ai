# Phone companion protocol (v1)

**Status:** the backend queue, pairing, frame storage, legacy transport adapter, and the Android
companion source are implemented. The Android APK has **not** been compiled on this machine: there
is no Android SDK or JDK 17, and the only volume had 797 MB free. Do not describe the APK or a real
phone run as verified until that build and a live pairing test have both happened.

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
- `phone_commands` and `phone_frames` carry `org_id` and `user_id` and are protected by the same
  forced RLS policy as every other tenant table.

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

`POST /api/devices/:id/op` exists for diagnosis. It rejects every mutating op with `403`: actions
must travel through a run with an approval, not through a second console path.

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
    {
      "wait_for": { "text": "Send", "timeout_ms": 8000 },
      "then": { "action": "tap_text", "text": "Send" },
      "optional": false
    }
  ]
}
```

The current Android translation supports `tap_text`/`tap`, `global` (`back`/`home`), and `none`.
Unsupported steps fail with `unsupported_step`. The first non-optional failure stops the flow.

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

The engine marks `phone_tap_text`, `phone_type`, and `phone_open_app` as `requiresApproval`.
`Agent` default-denies a tool marked `requiresApproval` when no approval callback is supplied.
`Agent` currently does not pass an approval id to the tool, and `CompanionPhone` enqueues actions
without an `approval_id`. The Android verifier refuses `act` and `flow` unless **both** `approval_id` and
`args_hash` are present, then checks that the arguments hash to the approved
value. Read-only ops do not require an approval. Therefore:

- read-only observation is usable now;
- phone actions are intentionally denied by the default-deny engine path;
- **approval-id binding and the chat approval flow are the next required step** before any action
  is described as production-ready. Until then, do not add an `approve` callback that executes a
  phone action without also threading the approval id and checking the approved row/hash on the
  server.

The server-side `approval_id` column, `args_hash`, and Android `CanonicalJson` verifier already
exist for that wiring.

---

## 7. Versioning and tests

`GET /api/phone/agent/version` returns:

```json
{ "protocol": 1, "min_app": "0.1.0" }
```

The companion sends `X-Talisman-App` and `X-Talisman-Protocol` on its JSON requests. Protocol
changes are additive; breaking changes should use a new path and keep the previous version for one
release.

Verified on 7 November 2026:

- server `tsc --noEmit`: pass;
- app `tsc -p app/tsconfig.json --noEmit`: pass;
- `tests/phone-queue.test.ts`: 4/4 pass — single-use/tenant-scoped pairing and hashed tokens,
  atomic claim/idempotent result/tenant-scoped frames, pause/rotate/revoke, and expired-command plus
  canonical-hash checks;
- `CanonicalJson` on Android has a matching Node test only for the Node implementation; a JVM/Node
  cross-check is still pending.

Not verified:

- Android compilation (no SDK/JDK) and therefore no APK;
- a real phone pairing, AccessibilityService run, screenshot, or live model action;
- chat approval UI and approval-id binding (see §6);
- frame retention/redaction and per-IP pairing rate limiting (not implemented).
