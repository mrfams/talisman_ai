# The user's phone as the host

**Status:** research and proposed architecture, November 2026. No companion code yet.
**Question:** how does Talisman operate the apps on a real phone without us hosting phones?

## The answer in one paragraph

Stop trying to reach the phone from the server. Put a small executor **on the phone**, let it
connect **outbound** to Talisman, and let it poll a command queue. The server plans, approves,
and records; the phone sees the screen and taps it. There is no inbound port, no phone rack, no
per-minute device bill, and no new host to operate: the existing Vercel app and Postgres are the
mailbox. Android can do this today with an AccessibilityService and no root or PC. iOS cannot do
general UI automation on-device at all; it needs either the user's Mac/PC as a bridge, cooperative
Shortcuts/App Intents, or a hosted iPhone as a last resort.

This is the inversion that makes the economics work:

```
 today (hosted phone)                     proposed (phone-hosted)
 ┌──────────┐   adb/HTTPS   ┌─────────┐   ┌──────────┐  outbound poll  ┌─────────┐
 │ Talisman │ ────────────► │  phone  │   │ Talisman │ ◄────────────── │  phone  │
 │  server  │               │  we run │   │  server  │ ──────────────► │  user's │
 └──────────┘               └─────────┘   └──────────┘   command queue └─────────┘
   we pay per phone, we patch it,          we host a queue; the phone does the work,
   the user's apps are not there           with the user's real apps and logins
```

The privacy story is also better: the apps, sessions, and 2FA live on the user's phone, not in
our infrastructure.

---

## 1. What each platform actually allows (verified, not assumed)

| Capability | Android | iOS |
| --- | --- | --- |
| Read the UI tree of other apps | Yes, AccessibilityService | Only through XCTest/WebDriverAgent (developer tooling) |
| Tap / swipe / type in other apps | Yes, `dispatchGesture`, `ACTION_SET_TEXT` | Only through WDA; no public API for a normal app |
| Screenshot other apps | Yes, `takeScreenshot()` API 30+, except `FLAG_SECURE` | WDA screenshot; iPhone Mirroring capture on macOS |
| Run without a PC | Yes, install an APK and enable the service | No, for UI automation; yes for Shortcuts/App Intents |
| Distribute on the official store | **No** for autonomous automation (Play policy) | **No** for UI automation (App Store) |
| Root required | No | No, but a signed WDA and a computer are required |
| Work while locked | No (screen must be on/unlocked) | No |
| Banking / password / DRM screens | Often blocked (`FLAG_SECURE`, app self-checks) | Often blocked or not inspectable |

Sources and caveats are at the end. The important consequence: **Android is the only platform
where "phone-only, no host" is real.** iOS is a bridge or cooperative story.

### 1.1 Android: the executor we can ship

An `AccessibilityService` is the same mechanism a screen reader uses. With
`android:canPerformGestures="true"` it can:

- read the node tree (text, content descriptions, resource ids, bounds, clickable/editable flags);
- tap, long-press, swipe, scroll, and go back/home/recents through `dispatchGesture` and global actions;
- set text in a focused field (`ACTION_SET_TEXT`) or send key events;
- take a screenshot on Android 11+ (`takeScreenshot`), except secure windows;
- launch apps and open deep links with `Intent`s;
- observe notifications (optional, separate permission) and react to them.

It cannot: unlock a PIN, defeat `FLAG_SECURE`, tap runtime permission dialogs, or reliably drive
canvas/game UIs. Some banking apps refuse to run while an accessibility service is enabled. Those
are product constraints, not bugs to hide.

**No root, no PC.** The user installs an APK, enables the service, and scans a pairing code. That is
the entire setup. This is the same architecture several open-source projects already ship:

- **Claw Use Android** (MIT) — one APK, foreground HTTP server on port 7333, semantic tree with
  stable refs (`/screen`, `/act`), flows that run on-device at 100 ms polling, MIUI survival guide.
- **OpenRing** (MIT) — on-device RPA and chat-driven agent with AccessibilityService; optional
  Gemini function calling or a local GGUF model.
- **DroidPilot** (MIT) — AccessibilityService + MCP over Wi-Fi, no ADB.
- **android-agent** (MIT) — on-device agent, explicitly sideload-only because Play will not take it.
- **Mobilerun Portal** — powerful (reverse WebSocket, WebRTC, install, SMS) but **AGPL-3.0**;
  we can learn from the protocol but should not vendor it into a proprietary product.

The fastest path is to **fork Claw Use (MIT)** as the executor base, strip its LAN server and PIN
storage, add our outbound queue, pairing, approvals, secure-window refusal, and branding. We keep
the MIT notice. If the fork becomes unmaintainable we can replace it behind the same protocol.

### 1.2 Android without our app: three fallbacks

| Route | What it gives | Cost |
| --- | --- | --- |
| **Shizuku** (open source, Play-distributable) | ADB-level shell from an app, no root. On Android 11+ the user pairs wireless debugging **on the phone itself**, no PC; after reboot they tap Start again. | Setup friction; not a UI-tree service by itself; good for install/settings/shell "power mode" |
| **Termux + adb** | `adb pair 127.0.0.1:<port>` then `adb connect localhost:<port>`; a script can poll our queue and run `uiautomator`/`input`. | Developer-only; Termux is not on Play; split-screen pairing dance |
| **Desktop browser + WebUSB (Tango)** | The user's Chrome drives the phone over USB using the ADB protocol; zero install on the phone. | Chromium only, USB cable, desktop only, can't control the phone from itself |

These are useful escape hatches and demos, not the default consumer path. The companion app is.

### 1.3 The Play Store problem (read this before designing the app)

Google's Accessibility API policy now says:

> Any use of the Accessibility API that enables an app to autonomously initiate, plan and execute
> actions or decisions is strictly prohibited.

Automation tools, assistants, and launchers are explicitly listed as *not* accessibility tools.
The October 2025 policy update reinforced this, and enforcement has been tightening through 2026.
So:

- **Do not ship the full Android companion on Google Play.** Ship it as a signed APK from GitHub
  Releases (Obtainium can keep it updated), with a clear "Talisman Phone Companion" page.
- Keep a separate **Play build** with no AccessibilityService: Shizuku power mode, deep links,
  cooperative actions, and "open on phone" handoffs only. Same account, fewer capabilities.
- On Android 13+, a sideloaded app's accessibility toggle is greyed out until the user opens
  App info → ⋯ → **Allow restricted settings**. Onboarding must detect and explain this.
- On Android 17 with **Advanced Protection Mode** on, only verified accessibility tools can
  register an AccessibilityService; sideloaded automation may be blocked entirely. Detect
  `AdvancedProtectionManager` and tell the user to turn AAPM off or use power mode. Do not
  pretend the service is working.

This is a distribution constraint, not a reason to give up: power users already sideload
automation tools, and the companion is explicitly a power tool.

---

## 2. The architecture: phone as executor, cloud as mailbox

```
┌────────────────────────────── Talisman (Vercel + Postgres) ──────────────────────────────┐
│                                                                                          │
│  planner / model ──► tool runtime ──► approval gate ──► phone_commands (queue)           │
│         ▲                  │                                   │                         │
│         │                  ▼                                   │                         │
│  run timeline ◄── results / observations ◄─────────────────────┘                         │
│         │                  │                                                             │
│         ▼                  ▼                                                             │
│  artifacts (frames, logs)   audit log                                                    │
└──────────────────────────────────▲───────────────────────────────────────────────────────┘
                                   │  outbound HTTPS long-poll (25 s), no inbound port
                                   │  result POST, frame POST
┌──────────────────────────────────┴───────────────────────────────────────────────────────┐
│ Talisman Companion (Android)                                                             │
│  foreground service ──► poll loop ──► command router ──► AccessibilityService            │
│        │                                   │                ├─ tree / screenshot        │
│        │                                   │                ├─ gestures / text / nav    │
│        │                                   │                └─ launch / deep link       │
│        └─ notification: Pause · Stop · status                                             │
│  local flow engine (recorded steps, no LLM)                                              │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### Why a queue and not a WebSocket

- Vercel Functions are request/response; a persistent WebSocket needs a relay (Durable Object,
  Supabase Realtime, Ably). That is another service to run and pay for.
- The phone is often behind CGNAT or a changing cellular IP. Outbound polling works everywhere.
- Phone actions take seconds anyway; a 0.5–2 s queue latency is invisible next to a 2 s model step.
- Long-poll (check, sleep 1 s, repeat for 20–25 s) keeps idle traffic tiny: one request per 20 s
  per device, and near-instant command pickup while a run is active.
- If we later want live finger-level control, add WebRTC as an **optional** upgrade, not the
  foundation. Cloudflare TURN has a 1 TB/month free tier; STUN is free.

### Command lifecycle

1. The planner calls a phone tool. The runtime resolves the user's device and checks risk.
2. Risky actions (send, pay, delete, post, follow, book) create an approval first. Nothing is
   queued until the user approves the exact payload.
3. The runtime inserts a `phone_commands` row with an idempotency key and a 60 s expiry.
4. The companion long-poll claims it, executes, and posts a result (and optionally a frame).
5. The runtime writes the observation into the run timeline and hands it back to the model.
6. If the phone dies mid-command, the row expires; the tool returns "device did not answer" and
   the planner can retry once, not loop.

### Observation format

Two layers, because they fail differently:

- **Tree first** (cheap, exact, 20–200 ms on-device): package, activity, nodes with
  `ref/text/desc/role/clickable/editable/scrollable/bounds/secure`.
- **Screenshot when needed** (icons, canvas, WebView, visual verification): JPEG, max 720 px,
  ~50–120 KB, only when the tool asks or the run is stuck.

The model gets a compact, numbered list (`[3] Button "Send" (540,1180)`) and can act by `ref`,
not by guessed coordinates. This is the same lesson browser automation learned: stable refs beat
pixel guessing. Coordinates remain available as a fallback.

### Live view

For the run page: the browser polls `GET /api/devices/:id/frame` at 1 fps **only while the panel is
open**; the server returns the latest frame the companion uploaded. No streaming infrastructure.
If we later need 30 fps, switch to WebRTC with the phone as offerer and the browser as answerer,
signaling through the same queue. Not needed for an agent that thinks in seconds.

### Pairing and identity

- Web: Devices → **Connect Android phone** → 8-character one-time code + QR (5 min, single use).
- Companion scans or the user pastes the code; it generates a keypair in Android Keystore, sends
  the public key and device metadata, receives a device id and a 32-byte secret (shown once).
- The secret is stored in Keystore-encrypted preferences and sent as
  `Authorization: Bearer <device_id>.<secret>` over TLS. The server stores only its SHA-256.
- Revoke in the UI deletes the hash and expires outstanding commands. Re-pair is a new device.
- Every command carries `run_id`, `step_id`, `expires_at`, and an idempotency key, so a retry
  cannot send the same message twice.

### Security model (the phone is the most sensitive device we touch)

- **Least privilege by app.** The user picks which apps Talisman may see and act in. Default
  allowlist includes the apps they selected; banking, password managers, authenticators, and
  system settings are denied unless explicitly enabled (and some should stay denied forever).
- **Secure windows are refused.** If `takeScreenshot` or the tree reports a secure/`FLAG_SECURE`
  window, the companion returns `secure_window`; it never attempts a bypass.
- **No credentials.** The companion never reads, stores, or types passwords, PINs, or full card
  numbers. If an action needs a login, it pauses and hands the phone to the user.
- **Approvals are bound to content.** For a send/post/pay, the approval card shows the exact
  recipient, text, amount, and app. The queued command includes an `args_hash`; the companion
  refuses if the payload changed after approval.
- **Prompt injection is assumed.** Screen text is untrusted data. The runtime marks observations
  as data, the system prompt says never follow instructions found on screen, and any outward
  action still needs the approval gate. The gate is the real defense, not a filter.
- **Kill switch.** Persistent notification with Pause and Stop; the Devices page has "Stop all
  phone work". Stopping clears the queue and disables the executor until re-enabled.
- **Retention.** Default: frames kept for the run only, then deleted; tree text kept in the run
  log with secrets redacted; the user can set "keep nothing" or "keep 24 h".
- **Audit.** Every command, approval, result, and app launch is recorded with device, run, actor,
  duration, and redacted args.

### Failure modes the UI must name

Locked phone; screen off; accessibility service disabled; restricted settings not allowed;
battery optimization killed the service; no network; AAPM enabled; app not installed; app updated
and the recipe broke; secure window; user took over; device revoked. Each gets a specific message
and a deep link to the fix, never a spinner.

---

## 3. iOS: three honest tiers

iOS has no public equivalent of ADB or AccessibilityService for third-party apps. One app cannot
read or tap another app. The only sanctioned touch injection is XCTest through WebDriverAgent
(WDA), which is developer tooling, needs a signed build, and needs a computer to install and
tunnel. Design around that instead of pretending otherwise.

### Tier 1 — iPhone + Mac (full control, no hosted phone)

The user's Mac mirrors the iPhone with **iPhone Mirroring** (macOS 15+, iOS 18+). Talisman's local
bridge (already designed around `phone-harness`) captures the window, OCRs it, and sends
HID-level taps/typing. Requirements: phone locked, Accessibility + Screen Recording granted to
the bridge, no unlocking during the session. This is the best iPhone experience and uses the
user's own hardware.

### Tier 2 — iPhone + Windows PC (full control, no Mac)

**SideTap** (MIT) proves the no-Mac route: sideload WebDriverAgent with a free Apple ID, tunnel
with `go-ios` over USB, drive the real UI tree. Free Apple IDs expire the signature every 7 days
(SideTap prompts and re-signs with one command); a paid Apple Developer account gives a year.
Package this as the Windows build of the Talisman Bridge. Still needs a PC and a cable, still no
hosted phone.

### Tier 3 — iPhone alone (cooperative, not autonomous)

What actually works without a computer:

- **Deep links / URL schemes** to open an app at a specific screen (`whatsapp://`, `maps://`,
  `tel:`, `mailto:`, app-specific schemes). Deterministic and fast.
- **App Intents / Shortcuts** for actions an app chooses to expose. Apple's 2026 App Intents
  work (schemas, onscreen awareness) lets an app annotate *its own* views for Siri; it is not a
  third-party screen-automation API. We can ship a **Talisman Shortcuts pack** using built-in
  actions (Messages, Mail, Calendar, Reminders, Notes, Maps, Music, Files, Safari) plus intents
  from apps that support them.
- **Share sheet / clipboard / notification actions**: the agent prepares the payload; the user
  taps once to hand it to the app.
- **Pushcut Automation Server** on a spare, plugged-in iPhone/iPad can run shortcuts without
  confirmation via its API. That is a real "phone as host" for shortcut-level actions, but it is
  a dedicated device and a subscription, and still cannot tap arbitrary apps.

Be explicit in the product: on iPhone without a Mac/PC, Talisman can *prepare and hand off*, not
operate any app end to end. That is a capability boundary, not a temporary bug.

### What not to do on iOS

- No jailbreak requirement.
- No "just use accessibility" claim: iOS does not expose other apps' trees.
- No private APIs or App Store distribution of WDA.
- No silent remote shortcut execution without a Mac/PC or a dedicated Pushcut server.

---

## 4. Build options, ranked

| Option | Time to demo | Coverage | Ops burden | Verdict |
| --- | --- | --- | --- | --- |
| **A. Fork Claw Use + outbound queue** | 1–2 weeks | Android, all apps the user enables | Low (APK + existing API) | **Build this first** |
| B. Write a Kotlin companion from scratch | 4–6 weeks | Same, cleaner code | Low | Later, if the fork creaks |
| C. Shizuku power mode | 1–2 weeks after A | Shell/install/settings, no accessibility | Low | Phase 2 add-on; also the Play build |
| D. Termux + adb client | days | Android power users | Medium support | Developer fallback only |
| E. WebUSB/Tango in the browser | 1 week | Android over USB, Chromium desktop | None on phone | Demo/QA path |
| F. Local bridge + phone-harness | exists | iPhone via Mac, Android via adb | User runs a process | Keep for iPhone tier 1/2 |
| G. Hosted cloud phones | exists | iPhone/Android anywhere | Highest cost | Fallback for no-device users |

**Recommendation:** A now, C and E as secondary paths, F for iPhone, G only as a paid fallback.
Do not build a phone farm.

---

## 5. What "operate my apps" should feel like

The agent should not be a remote-control robot. It should be a worker with a phone.

1. **Say the job, not the taps.** "Order my usual from the coffee place" or "Reply to the last
   message from Sam and say I'll be 10 minutes late."
2. **Watch it work.** The run page shows the live frame, the current app, the step, and a
   one-line narration. The phone shows a notification: "Talisman is working — Pause".
3. **Approve the risky part.** The exact message/amount/recipient is shown before it is sent.
4. **Take over when needed.** A login, CAPTCHA, Face ID, or payment confirmation pauses the run
   and asks the user to finish on the phone; the agent resumes from the observed screen.
5. **Learn the flow.** Once a sequence succeeds, save it as an on-device **flow** (deterministic
   steps with waits and fallbacks). Next time it runs in seconds without model calls. This is the
   single biggest reliability and cost win.
6. **Tell the truth when it can't.** "Your bank app blocks screen access" is a valid result.

### Ideas worth building (ranked by leverage)

1. **Phone-as-executor queue** — the foundation; no host, real accounts, private.
2. **Learn-once flows** — record a successful path, replay on-device with 100 ms polling and no
   LLM. Claw Use's `flows.md` proves the pattern; make it a first-class product object with
   versions, app-version pins, and a test button.
3. **App cards / recipes** — per-app capability declarations: what it can read, what it can do,
   risk level, known blockers, deep links, accessibility ids. Start with 10 apps, not 100.
4. **Approval with exact payload** — the trust feature that makes phone automation usable.
5. **Live takeover** — hand the phone back for login/payment; resume after.
6. **Spare-phone worker** — an old Android phone, charged, on Wi-Fi, with its own accounts, is a
   dedicated agent device with zero hosting. Great for families and small businesses.
7. **Shortcuts pack + deep links for iPhone** — honest cooperative value on iOS.
8. **Desktop WebUSB** — "try it now" with no install; good for demos and QA.
9. **Notification/2FA triggers** — "when my code arrives, finish the login" (off by default,
   redacted, approval-gated).
10. **On-device redaction / local model** — strip card numbers, emails, OTPs before uploading;
    later, a small local model for grounding and simple flows.

### What not to build

- A cloud phone farm we have to patch, heat, and pay for.
- A Play Store build that claims to be an accessibility tool.
- PIN storage or remote unlock (Claw Use does this; we should not).
- `FLAG_SECURE` bypasses.
- An OCR-only agent that guesses pixels when a tree exists.
- Silent autonomous sending/paying.

---

## 6. Economics

| Item | Hosted cloud phone | Phone-hosted |
| --- | --- | --- |
| Device | per-minute rental (Phone Harness Cloud: ~$5 credit / 100 min) | $0, user's device |
| Compute | host per phone | $0; existing Vercel functions |
| Queue | n/a | existing Postgres; ~1 request / 20 s / active device |
| Screenshots | included | ~1 MB per 10-step task, optional |
| LLM | same | same, often fewer calls with flows |
| Support | device provisioning, patching | OEM onboarding, permissions |

At 1,000 tasks/month × 15 steps, the queue is a rounding error next to model tokens. The real
cost is support: Android OEM battery settings and permissions. Budget for onboarding, diagnostics,
and a "doctor" screen, not servers.

Scale ceiling: a long-poll loop does one indexed `SELECT` per second per active device. That is
fine for hundreds of concurrent runs on the current Postgres; if we reach thousands, move the
queue to a dedicated relay (Cloudflare Durable Object/Upstash) without changing the protocol.

---

## 7. Thirty / sixty / ninety days

### Days 1–14 — prove the loop

- Fork Claw Use (MIT), remove the LAN HTTP server and PIN storage, add:
  - pairing (code → Keystore key → device token),
  - outbound long-poll + result POST,
  - package allowlist, secure-window refusal, notification with Pause/Stop.
- Backend: `phone_devices`, `phone_commands`, `phone_frames`; pair/poll/result/frame endpoints;
  `CompanionPhone` implementing the existing `PhoneTransport`.
- Agent tools: `phone_look`, `phone_open_app`, `phone_tap`, `phone_type`, `phone_swipe`,
  `phone_home/back`, `phone_read_screen` — all mapped to `observe`/`act`.
- Demo on a real Android phone: open Settings, read battery, open WhatsApp, draft (not send) a
  message, show the frame in the run page.

### Days 15–45 — make it safe and usable

- Approval gate for send/pay/delete/post with exact payload and `args_hash`.
- Devices page: QR pairing, permissions checklist, battery/last-seen, test read, revoke, kill switch.
- Android onboarding: restricted settings, battery exemption, OEM autostart, AAPM detection.
- Live frame in run detail; "Take over" flow.
- Five app recipes (Messages/WhatsApp, Gmail, Calendar, Maps, Chrome) and one flow recorder.
- Audit log, redaction, retention settings; `talisman doctor` diagnostics.
- Internal red-team: prompt injection, malicious screen text, secure windows, revoked device.

### Days 46–90 — coverage and the iPhone story

- Ship the signed APK + Obtainium instructions; versioned protocol; auto-update check.
- Windows/macOS **Talisman Bridge** for iPhone: wraps phone-harness/SideTap, connects outbound to
  the same queue (no inbound ports); setup doctor for WDA/Mirroring.
- iOS Shortcuts pack + deep-link actions; label iPhone-alone as cooperative.
- Shizuku power mode (install APK, toggle settings, read notifications) and a Play build without
  accessibility.
- WebRTC live view (optional), scheduled phone jobs, spare-phone mode.
- Pricing/limits and a support playbook for the top 10 Android OEMs.

---

## 8. Decisions this needs from you

1. **Android-first?** It is the only path to phone-only automation; iOS needs a computer for full
   control. Recommended: yes.
2. **Is a sideloaded companion acceptable?** Full Android automation cannot ship on Play. If not,
   the Android product is Shizuku + deep links only, and coverage drops sharply.
3. **iPhone without a Mac/PC:** cooperative Shortcuts only, or require the Bridge? Recommended:
   cooperative, with the Bridge as the upgrade.
4. **Fork Claw Use vs. build from scratch:** fork for speed, keep the protocol ours. Recommended.
5. **Default privacy:** tree-only (no screenshots) or screenshots allowed? Recommended: tree by
   default, screenshot on demand, run-only retention.

---

## 9. Open risks

- **Policy:** Play prohibits autonomous accessibility automation; Android 17 AAPM can block
  sideloaded services for security-conscious users. Sideload distribution and clear disclosure are
  the mitigation, not a loophole.
- **Security:** this is the most sensitive integration in the product. A compromised device token
  can read a screen and tap. Short-lived tokens, revocation, approvals, allowlists, and no
  credential handling are mandatory.
- **Reliability:** OEM battery managers kill background services; apps update and break recipes.
  Flows need version pins and a "test this flow" button; the UI must surface breakage.
- **Legal/ToS:** automating a third-party app may violate its terms. The user owns the device and
  the accounts; we provide the tool, require consent, and avoid spam/abuse features.
- **iOS:** WDA is developer tooling; no App Store path. Be explicit, do not oversell.
- **Privacy:** screen text can contain anything. Default to minimal retention and redaction, and
  never send a frame to the model unless the step needs it.

---

## 10. Sources

Android / policy

- AccessibilityService API policy (autonomous actions prohibited):
  https://support.google.com/googleplay/android-developer/answer/10964491
- Play policy announcement, 30 Oct 2025:
  https://support.google.com/googleplay/android-developer/answer/16550159
- Android Advanced Protection Mode (Android 17 accessibility restrictions):
  https://developer.android.com/privacy-and-security/advanced-protection-mode
- Create an accessibility service (gestures, screenshots):
  https://developer.android.com/guide/topics/ui/accessibility/service
- Foreground service types (`specialUse`, `connectedDevice`):
  https://developer.android.com/develop/background-work/services/fgs/service-types
- Shizuku setup via wireless debugging, no PC:
  https://shizuku.rikka.app/guide/setup/
- Termux localhost adb pairing:
  https://github.com/ferrumclaudepilgrim/claude-code-android/blob/main/docs/add-ons/adb-wireless.md
- Tango / WebUSB ADB in the browser:
  https://docs.tangoapp.dev/ and https://github.com/yume-chan/ya-webadb

Executors and prior art

- Claw Use Android (MIT): https://github.com/claw-use/claw-use-android
- OpenRing (MIT): https://github.com/SunZhi-Will/OpenRing
- DroidPilot (MIT): https://github.com/youichi-uda/droidpilot
- android-agent (MIT, sideload-only): https://github.com/Fox-Islam/android-agent
- Mobilerun Portal (AGPL, reference only): https://github.com/droidrun/mobilerun-portal
- Phone Harness (vendored, MIT): https://github.com/phone-harness/phone-harness

iOS

- SideTap: free-Apple-ID WDA sideload, Windows, USB: https://www.sidetap.io/
- App Intents for system experiences:
  https://developer.apple.com/documentation/appintents/adopting-app-intents-to-support-system-experiences
- Onscreen awareness and App Schemas (WWDC26):
  https://developer.apple.com/videos/play/wwdc2026/343
- Pushcut Automation Server:
  https://www.pushcut.io/support/automation-server

Transport / infrastructure

- Vercel Functions duration limits:
  https://vercel.com/docs/functions/limitations
- Cloudflare TURN (1 TB/month free, $0.05/GB after):
  https://developers.cloudflare.com/realtime/turn/
