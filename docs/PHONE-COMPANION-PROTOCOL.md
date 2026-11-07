# Phone companion protocol (v0)

**Status:** proposed contract for the Android companion and the Talisman Bridge. No implementation
yet. This is deliberately small: a queue, three device endpoints, one command envelope, one result
envelope, and a frame upload.

The goal is that the executor can be replaced (Claw Use fork now, first-party app later) without
changing the server or the agent tools.

---

## 1. Tables

```sql
-- one row per paired phone
CREATE TABLE phone_devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           text NOT NULL,
  platform       text NOT NULL CHECK (platform IN ('android', 'ios', 'bridge')),
  model          text,
  os_version     text,
  app_version    text,
  public_key     text,                 -- base64url, optional for v0
  token_hash     text NOT NULL,        -- sha256(secret), never the secret
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'paused', 'revoked')),
  capabilities   jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb, -- allowlist, retention, screenshot policy
  last_seen_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);

-- one row per action the agent wants the phone to take
CREATE TABLE phone_commands (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       uuid NOT NULL REFERENCES phone_devices(id) ON DELETE CASCADE,
  run_id          uuid REFERENCES tasks(id) ON DELETE SET NULL,
  step_id         uuid REFERENCES task_steps(id) ON DELETE SET NULL,
  approval_id     uuid,
  idempotency_key text NOT NULL,
  op              text NOT NULL,
  args            jsonb NOT NULL DEFAULT '{}'::jsonb,
  args_hash       text,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'claimed', 'done', 'error', 'expired', 'cancelled')),
  expires_at      timestamptz NOT NULL,
  claimed_at      timestamptz,
  completed_at    timestamptz,
  result          jsonb,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, idempotency_key)
);

CREATE INDEX phone_commands_queue
  ON phone_commands (device_id, status, created_at)
  WHERE status = 'queued';

-- latest frame per device; overwritten, not a history
CREATE TABLE phone_frames (
  device_id   uuid PRIMARY KEY REFERENCES phone_devices(id) ON DELETE CASCADE,
  seq         bigint NOT NULL DEFAULT 0,
  jpeg        bytea NOT NULL,
  width       int,
  height      int,
  captured_at timestamptz NOT NULL DEFAULT now()
);
```

The existing `devices` concept in `docs/PHONE-HARNESS.md` becomes `phone_devices`; the old
`PHONE_BRIDGE_URL` transport stays for local harnesses but is no longer the primary path.

---

## 2. Endpoints

All endpoints are HTTPS, JSON unless stated. Device endpoints authenticate with a device token;
browser endpoints use the normal session cookie.

### Pairing (browser + device)

`POST /api/phone/pair/start` (session auth)

```json
{ "platform": "android", "name": "Pixel 9" }
→ { "code": "7K4M-2Q9X", "expires_at": "2026-11-07T12:05:00Z",
    "qr": "https://talisman-agent.vercel.app/phone/pair#code=7K4M-2Q9X" }
```

`POST /api/phone/pair/claim` (no session; the code is the secret)

```json
{ "code": "7K4M-2Q9X", "platform": "android", "model": "Pixel 9",
  "os_version": "16", "app_version": "0.1.0", "public_key": "..." }
→ { "device_id": "uuid", "token": "uuid.32-byte-secret", "name": "Pixel 9" }
```

Rules: code is 8 characters from an unambiguous alphabet, 5-minute TTL, single use, rate-limited
by IP and code; the token is returned exactly once. The device stores it in Keystore-encrypted
preferences.

### Work loop (device auth)

`POST /api/phone/agent/poll`

Headers: `Authorization: Bearer <device_id>.<secret>`

- Long-poll: check for a queued command for this device; if none, sleep 1 s and repeat for up to
  25 s (stay under the Vercel function limit), then return `204`.
- Claim atomically:

```sql
UPDATE phone_commands
SET status = 'claimed', claimed_at = now()
WHERE id = (
  SELECT id FROM phone_commands
  WHERE device_id = $1 AND status = 'queued' AND expires_at > now()
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING id, op, args, run_id, step_id, approval_id, expires_at;
```

- Update `phone_devices.last_seen_at` at most once per poll (not every second).

Response:

```json
{ "command": {
    "id": "uuid", "op": "act",
    "args": { "action": "tap_ref", "ref": 3 },
    "run_id": "uuid", "step_id": "uuid",
    "approval_id": null,
    "args_hash": "sha256:...",
    "expires_at": "2026-11-07T12:03:10Z"
} }
```

`POST /api/phone/agent/result`

```json
{ "command_id": "uuid", "status": "done",
  "result": { "ok": true, "observed": { "package": "com.whatsapp", "refs": 12 } },
  "duration_ms": 840 }
```

or

```json
{ "command_id": "uuid", "status": "error", "error": "secure_window" }
```

The server ignores a result for a command that is not `claimed` (idempotent retries).

`POST /api/phone/agent/frame` (`Content-Type: image/jpeg`, max 300 KB)

Header: `X-Talisman-Seq: 42`. The server replaces `phone_frames` for the device. Only called when
a viewer is active or the command asked for a screenshot.

`POST /api/phone/agent/heartbeat` (optional; poll already updates presence)

```json
{ "battery": 0.72, "charging": true, "screen": "on", "a11y": true, "locked": false }
```

### Browser / run endpoints

- `GET /api/devices` → list with status, battery, last seen, capabilities, settings.
- `DELETE /api/devices/:id` → revoke; queued commands become `cancelled`.
- `POST /api/devices/:id/pause` / `resume` → status toggle; the companion stops claiming commands.
- `GET /api/devices/:id/frame` → latest JPEG, `Cache-Control: no-store`; 404 when none.
- `POST /api/devices/:id/op` → manual/debug op, always approval-gated and audit-logged.
- `GET /api/devices/:id/diagnostics` → permissions, AAPM, battery optimization, last error.

---

## 3. Ops

Keep the surface small enough to implement safely. Coordinates are device pixels. Refs are only
valid for the observation that produced them; a new observation invalidates old refs.

| Op | Args | Returns | Risk |
| --- | --- | --- | --- |
| `observe` | `screenshot?: bool`, `include?: "interactive" \| "all"` | package, activity, nodes, optional JPEG | none |
| `act` | `action: tap_ref \| tap \| long_press \| type \| swipe \| scroll \| global \| launch \| deep_link` | ack + observed package | action-dependent |
| `flow` | `steps: Step[]` | per-step results | action-dependent |
| `apps` | `include_system?: bool` | launchable packages + labels | none |
| `status` | — | battery, screen, locked, a11y, version | none |

`act` examples:

```json
{ "action": "tap_ref", "ref": 3 }
{ "action": "tap", "x": 540, "y": 1180 }
{ "action": "type", "ref": 5, "text": "I'll be 10 minutes late", "submit": true }
{ "action": "swipe", "direction": "up", "distance": 0.6 }
{ "action": "global", "name": "back" }
{ "action": "launch", "package": "com.whatsapp" }
{ "action": "deep_link", "uri": "whatsapp://send?text=..." }
```

`flow` step:

```json
{ "wait_for": { "text": "Send", "timeout_ms": 8000 },
  "then": { "action": "tap_text", "text": "Send" },
  "optional": false }
```

The executor polls the tree every 100–250 ms for `wait_for`, then acts. It stops on the first
non-optional failure and returns the failing index and the last observed screen. Flows are stored
on the device and versioned by app version; the server keeps a copy for portability.

### Result envelope

```json
{
  "ok": true,
  "data": {},
  "screen": {
    "package": "com.whatsapp",
    "activity": "com.whatsapp.Conversation",
    "refs": 18,
    "hash": "sha256:...",
    "secure": false
  },
  "timing": { "observe_ms": 90, "act_ms": 240 },
  "warnings": []
}
```

Errors are stable codes, not prose: `secure_window`, `locked`, `a11y_off`, `restricted_settings`,
`no_network`, `app_not_found`, `ref_stale`, `timeout`, `cancelled`, `approval_mismatch`,
`denied_package`, `aapm_blocked`.

---

## 4. Risk classes and approvals

Every `act` is classified **before** it is queued:

- `read` — observe, apps, status. No approval.
- `navigate` — back/home/recents, scroll, launch, deep link to a non-destructive screen. No approval.
- `input` — typing into a non-sensitive field. Approval once per run for the app, unless the
  payload is a message/comment/post.
- `outward` — send, post, reply, follow, call, book, order. Approval with exact payload.
- `money` — pay, transfer, purchase. Approval with amount and recipient; never auto-approve.
- `destructive` — delete, archive, block, unsubscribe. Approval.
- `sensitive` — passwords, OTP, card numbers, government IDs. The executor refuses; hand off.

The runtime creates an `approvals` row with `{device_id, run_id, op, args, preview}`; on approve it
queues the command with `approval_id` and `args_hash`. The companion verifies that the args it
executes still hash to `args_hash`; if not, it returns `approval_mismatch` and does nothing.

The companion also enforces:
- package allowlist (default: user-selected apps);
- package denylist (banking, password managers, authenticators, settings) — denied unless the user
  explicitly overrides, and some are permanently denied;
- secure windows: no screenshot, no tree text beyond the package name; return `secure_window`;
- screen must be on and unlocked; otherwise `locked` and the run pauses for the user.

---

## 5. Pairing and token details

- Secret: 32 random bytes, base64url. Stored server-side only as `sha256(secret)`.
- Device header: `Authorization: Bearer <device_id>.<secret>`; constant-time compare.
- Rotation: `POST /api/devices/:id/rotate` returns a new secret once; the old one is invalid
  immediately. The companion re-pairs if it cannot authenticate.
- Revocation: deletes `token_hash`, sets `status='revoked'`, cancels queued commands. The
  companion's next poll gets `401` and stops.
- Pairing code: 8 chars from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, 5 min, one use, max 5 attempts.
- No device secret ever appears in logs, the browser, or a screenshot.

---

## 6. Retention and redaction

- Frames: default delete after the run ends; `phone_frames` is overwritten and has a TTL sweep.
- Tree text: stored in the run step with a redactor for emails, phone numbers, card-like numbers,
  and 4–8 digit codes. The raw tree is available to the model only for the current step.
- OTP: read only if the user enabled "read verification codes" for that device; the code is never
  written to the transcript unredacted and is not stored after the step.
- Audit: args are stored redacted; the exact approved payload is stored on the approval row until
  the run is deleted.

---

## 7. Versioning

- `GET /api/phone/agent/version` returns `{ "protocol": 1, "min_app": "0.1.0" }`.
- The companion sends `X-Talisman-App` and `X-Talisman-Protocol` on every request.
- The server refuses commands the app's `capabilities` do not include, with `unsupported`.
- Protocol changes are additive; breaking changes bump the path (`/api/phone/v2/...`) and the app
  supports the previous version for one release.

---

## 8. Test plan

- Fake companion (Node) that implements poll/result/frame against a real test database; covers
  claim atomicity, expiry, idempotency, revocation, approval mismatch, and stale refs.
- Contract tests for every op and every error code; no Android emulator required.
- One opt-in live test (`PHONE_LIVE=1`) against a real Android phone; never reported as passed
  when skipped.
- Security tests: replayed result, forged token, expired command, changed args after approval,
  secure window, denied package, revoked device.
