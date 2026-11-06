## What does this PR do?

<!-- What breaks today, and what does this change about it? One paragraph is plenty. -->



## Related Issue

<!-- Link it. If there is no issue, describe the symptom you hit here instead. -->

Fixes #

## Type of Change

- [ ] 🐛 Bug fix
- [ ] ✨ New feature
- [ ] 📝 Documentation
- [ ] ♻️ Refactor (no behaviour change)
- [ ] ⚠️ Breaking change (describe it under Changes Made)

## Changes Made

<!-- The specific changes, with file paths. -->

-

## How did you verify it?

**This repo has no test suite. Verification happens on a phone, so this section
is the review.** Tell us what you *observed*, not what you expect to happen.

| | |
|---|---|
| macOS version | |
| iPhone iOS / Android version | |
| Transport | background (default) / mirror (`PHONE_HARNESS_BACKGROUND=0`) / adb |
| App or screen you tested on | |

**Before the change** — what the phone did, and what the harness reported:

```

```

**After the change** — same:

```

```

<!--
Two things worth knowing, because they have burned us repeatedly:

  * "nothing happened" is ambiguous. A list already at its end looks exactly
    like a broken gesture. Say how you knew there was somewhere left to go.

  * a helper returning success is not evidence. `moved=True` has been returned
    for a screen that never changed. Say what you saw on the phone.
-->

## Checklist

- [ ] I pulled latest `main` first and confirmed the bug still happens
      <!-- Several PRs have re-fixed things that were already fixed. -->
- [ ] `phone-harness --doctor` passes on my machine
- [ ] This PR contains only changes for this one fix
- [ ] I updated `SKILL.md` if I changed what an agent should do — or N/A
- [ ] I updated docstrings if I changed what a helper returns — or N/A

## Anything you tried that did NOT work

<!-- Optional, and genuinely useful. The dead ends are usually the expensive
     part to rediscover, and they tell a reviewer which explanations are
     already ruled out. -->

-

## Screenshots / Logs

<!-- Screen recordings are ideal for gesture changes: before/after stills miss
     a gesture that fires and then gets undone. -->
