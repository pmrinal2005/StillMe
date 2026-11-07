# ReVOICE — Human-Gated Conversational Voice Prosthesis

**AI listens so the human can speak.** The partner speaks, AssemblyAI transcribes, Groq drafts three editable replies, **the user approves the exact words**, and AssemblyAI speaks only those words.

ReVOICE is an assistive communication (AAC) prototype. It is **not** an autonomous voice agent. A detected pause is not consent, and a plausible reply is not what the user means.

> Stack: Next.js (App Router) · React · TypeScript · Tailwind · Zod · Dexie/IndexedDB · Supabase (optional server-side store only — no sign-in) · LiveKit Cloud Build (media and Python worker) · AssemblyAI BYOK (STT `universal-3-6-pro`, TTS `assemblyai-tts-1`) · Groq (`openai/gpt-oss-20b`).
> **Never Cloudflare, never Hono.** Frontend target: Vercel Hobby.

---

## 0k. Partner link, worker-less captions, mode-aware session end, numbers/dates in auto-speak (this release)

Deploys on **Vercel** (Next.js preset, `vercel.json` + `.vercelignore` included). No Cloudflare, no Hono, no sign-in anywhere.

| TODO | What was wrong | Fix | Where |
|---|---|---|---|
| 1 | Auto-speak refused every draft containing a digit, so "What time on March 3rd?" was never proposed | `SPECIFICS` now blocks **links and e-mail addresses only**. Numbers and dates are allowed. Money, health, legal, consent and commitments stay blocked by `HIGH_STAKES` / `COMMITMENT` / the `risk` category, on the browser **and** in the server backstop | `src/lib/turn-taking.ts`, `tests/turn-taking.test.ts`, `tests/auto-approval.test.ts` |
| 2 | Invite was **burned before** the LiveKit token was minted, so any error after that locked the partner out | Token + claim are minted **first**, the invite is consumed second | `src/app/api/livekit/join/route.ts` |
| 2 | A partner whose phone reloaded, locked or changed network could never get back in (single-use link) | **Claim-based rejoin.** A successful join returns a signed claim (`rvc1.<room>.<partner identity>.<exp>.<sig>`, bound to the owner, expires with the room, max 30 min). The same phone keeps it in `sessionStorage` and gets a new token for the **same identity** with a **Rejoin** button. Leaving on purpose clears it | `src/lib/server/livekit.ts`, `src/lib/invite-link.ts`, `src/app/join/page.tsx` |
| 2 | Rooms closed after 120 s empty / 30 s departure, too short for a partner to open a link or for a phone to reload | Partner-link / remote rooms: **300 s / 120 s**. Tabletop keeps 120 / 30 | `src/lib/session-policy.ts` |
| 2 | `decodeURIComponent(location.hash)` threw on a link cut by a chat app and blanked the page | `parseInviteFromHash` never throws; strips whitespace and trailing punctuation; accepts `#invite=` and double-encoded values | `src/lib/invite-link.ts` |
| 2 | Raw codes (`http_502`, `Could not join (join_failed)`) shown to a partner | One plain-language message per error, with a *fatal* flag that hides Retry | `src/lib/join-errors.ts` |
| 2 | No expiry shown | Partner page shows a live countdown and disables Join when expired; owner sees *Partner link expires in 28 min 10 s* | `join/page.tsx`, `ReVoiceApp.tsx` |
| 2 (bug found by the local e2e) | `/api/livekit/session` returned `invite` as the whole `{invite, jti, exp}` **object**, so the owner's link read `/join#[object Object]` | Returns the string, plus `inviteExpiresAt` | `src/app/api/livekit/session/route.ts` |
| 3 | With no worker deployed, partner-link / remote sessions showed no captions and were **auto-killed after 45 s** | **Partner-phone relay STT.** The owner reserves minutes (same ledger) and sends the partner's phone a short-lived AssemblyAI URL **addressed to that one partner**; the phone transcribes its own mic (the track LiveKit already publishes) and relays turn text back. It never runs next to a working worker (no two paid streams), stops when the worker returns or the partner leaves, and the owner's voice gates it (`relay_gate`) | `src/lib/client/partner-relay.ts`, `listening.ts`, `ReVoiceApp.tsx`, `src/lib/relay.ts` |
| 3 | Only the owner device could be trusted for control | Relay is locked down: commands accepted only from `role=owner`; turns only from the targeted `partner-…` (server-signed `role` attribute); URL must be `wss://streaming[.eu].assemblyai.com/v3/ws?`; relay messages carry **text only**, never an approval, so relay text can never become speech | `relay.ts`, `contracts.ts` |
| 3 | The 45 s worker-absent kill and "the session ends automatically" wording applied to every mode | Only **tabletop** is ever ended for a missing worker, and only when browser listening is unavailable. Partner modes stay open and say so | `ReVoiceApp.tsx`, `workerAbsentAction()` |
| 3 | `pagehide` ended partner sessions (locking the owner's phone dropped the partner) | `backgroundPolicy(mode)`: tabletop ends on pagehide / 3 min hidden; **partner modes never end on pagehide** (10 min hidden limit; bfcache restores ignored) | `session-policy.ts`, `ReVoiceApp.tsx` |
| 3 | Worker closed the room 30 s after the owner's connection blinked, in every mode | `OWNER_GONE_GRACE_BY_MODE`: tabletop **30 s**, partner-link / remote **120 s** (web and worker constants are tested to match) | `worker/revoice_worker/config.py`, `watchdog.py`, `main.py` |
| hygiene | `.env.example` had `NEXT_PUBLIC_SUPABASE_*` (2 failing tests); a duplicate `env.example` | Rewritten and complete, duplicate removed, `.vercelignore` added | `.env.example`, `.vercelignore` |

### Checks (this pass)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` | 24 files, **467** tests pass (was 423/425) |
| `cd worker && pytest -q` | **120** pass (+3 for owner-gone grace by mode) |
| `npm run build` + `postbuild` secret scan | pass, 41 browser files, no leaks |
| AssemblyAI key, REST `/v2/transcript` | 200 |
| AssemblyAI key, streaming token mint | 200 |
| TTS with numbers and dates ("5 pm on March 3rd, room 12", "03/04/2027 at 7:30") | 200, audio returned, billed per character |
| `npm run smoke:live` (providers) | **28/28**: 24 library voices, Hindi rejected 422, `universal-3-6-pro` STT round trip |
| `npm run smoke:live` against the production build | **41/41** |
| `npm run smoke:worker` (plugin TTS to plugin STT to TurnAdapter) | all pass |
| **Local LiveKit server e2e** (real `livekit-server` 1.9.0 + real routes, `node /tmp/e2e` style) | **24/24**: forged/garbage invite and claim refused, valid join returns claim, partner token = mic + data only, invite burned after use, claim rejoin keeps the same identity, swapped-identity claim refused, partner room really has 300 s / 120 s timeouts (tabletop 120 / 30), relay URL minted and **handshakes with AssemblyAI**, relay pseudo-session settles, rejoin after the room ended is `410 session_ended` |

### Limits from the docs (re-read this pass)

* **LiveKit Build (quotas-and-limits):** 5 concurrent agent sessions, 1,000 agent minutes, 5,000 WebRTC participant minutes, 50 GB transfer, **$2.50** Inference credit, 100 participants, Server API 1,000 req/min, agent cold start **10 to 20 s**, 1 US number and 50 inbound minutes, 1,000 third-party SIP minutes. The allowance is a **hard cap** on the free plan. Custom-voice cloning through LiveKit Inference is not available on Build, which is why this app clones through AssemblyAI directly.
* **AssemblyAI:** free accounts open **5 new streaming sessions per minute**, pay-as-you-go starts at 100. `/api/stt-token` refuses early with a retryable `stt_rate_limited`. The relay reserves its minutes through this same route, so it is counted and capped like any listening.

### Honest limits of this release

* The relay needs the partner's phone to keep the page open (a locked phone stops its microphone). The owner is told when the relay stops.
* Only the earliest partner transcribes; a second partner's speech is not captioned while a relay is on (never two paid streams on one room).
* The browser parts (join page, relay worklet) were verified by type-check, unit tests and the real server routes, not by a physical phone.
* Groq was not configured in this sandbox. Its logic is covered by the mocked tests.
* **Never put the AssemblyAI key in a file.** Add it in Vercel, Settings, Environment Variables. The key used for these checks was shared in chat: rotate it.

## 0j. Listening-quota lockout + unclickable suggestion cards (this release)

**Reported:** (1) *Start listening* hung, then said `Could not start listening (stt daily minutes)`. (2) After speech was processed, the suggestion cards could not be clicked or applied to the composer.

### Root causes

| # | Cause (found by tracing the code) | Fix |
|---|---|---|
| 1a | `LIMITS.assembly.dailyFlagshipListeningMinutes = 40`. Every *Start listening* **reserves up to 20 min up front**, so two full reservations used the whole day. | The daily minute cap is now **off by default** (`0`). Opt in with `REVOICE_STT_DAILY_MINUTES=40`. The 20-min session cap, the $/day ceiling and the protected credit reserve still bound spend. |
| 1b | Refunds only worked on the serverless instance that made the reservation (in-memory cache). On Vercel, `/api/livekit/end` usually lands on another instance, so the reservation stayed charged. | `settleLocalStt` now refunds from the **signed session ticket** (reserved minutes + day), once per room. |
| 1c | A LiveKit attempt that fell back to direct listening reserved minutes twice. | Failed/abandoned attempts are settled (existing path) and the cap no longer applies by default. |
| 1d | No way to clear a stuck allowance. | `POST /api/operator/reset-stt` + **Settings -> Owner tools -> Reset listening quota** (needs `REVOICE_OPERATOR_TOKEN`; fail-closed). Also releases stuck `reserved` rows in Supabase when configured. |
| 2a | `Suggestions.tsx`: the **Use** button was `disabled={!!stale}`. | Never disabled. When the Conversation Brake flagged the set, the button reads *Use anyway (edit first)*, the composer shows the "context changed" badge and the text is sent as the owner's **own words** (no AI proof), so the safety model is unchanged. |
| 2b | The Brake fired on harmless partial -> formatted-final changes (`seven o'clock` -> `7 o'clock.`) because number words and digits were compared as different tokens, so cards went grey almost every turn. | `materialChange` normalizes number words and `:00` first. Real changes (negation, a different number/date, topic change) still trip it. |
| 2c | Stale state was cleared when a card was applied, hiding the warning. | `useCandidate` keeps the stale flag in the composer. |

### Checks against the AssemblyAI docs and LiveKit quotas

* AssemblyAI: **free accounts allow 5 new streaming sessions per minute** (pay-as-you-go 100+). `/api/stt-token` now refuses early with a friendly, retryable `stt_rate_limited` (override `REVOICE_STT_SESSIONS_PER_MIN`) instead of reserving minutes and failing at the WebSocket handshake. Non-normal WebSocket close codes are now shown to the owner.
* LiveKit Build (quotas-and-limits): **5 concurrent agent sessions**, 1,000 agent minutes, **agent cold start 10-20 s**. `/api/livekit/session` refuses when 5 owner rooms are already live (client falls back to direct listening); the worker-join timeout is 22 s (was 12 s) so a cold start is not mistaken for "no worker".
* Live key checks (key supplied via environment only, never stored): REST `/v2/transcript` 200; streaming token mint 200; 24 library voices synthesize; Hindi TTS rejected 422; `universal-3-6-pro` Begin -> Turn(partial) -> Turn(end_of_turn) -> Termination(1000) round trip; the app's own minted `wsUrl` handshakes.

### Verification (this pass)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` | 23 files, 417+ tests pass (3 tests that asserted the old hard 40-min cap now cover both modes) |
| `cd worker && pytest -q` | 117 pass |
| `npm run build` + secret scan | pass, no leaks |
| 5 start/stop cycles against the real route | all granted, none blocked by `stt_daily_minutes` |
| Headless Chromium (real pointer click) | cards enabled and hit-testable, click fills the composer, also when stale |

> **Never put the AssemblyAI key in a file.** Add it in Vercel -> Settings -> Environment Variables. The key used for these checks was shared in chat: rotate it in the AssemblyAI dashboard.

## 0i. Final verification pass: server backstop for auto turn-taking, repo cleanup, live checks

What was wrong when this pass started (the previous commit message claimed more than the tree contained):

| Problem found | Fix |
|---|---|
| The "deleted" auth files were still in the repo (`AuthControls.tsx`, `client/supabase.ts`, `auth-providers.ts`, `auth-note.ts`, `prefs-sync.ts`, `/api/account/*`), and `env.example` duplicated `.env.example` | Removed. `.env.example` has no `NEXT_PUBLIC_SUPABASE_*` and defaults `REVOICE_ALLOW_BROWSER_STT=true` |
| Two competing turn-taking designs: an unwired `client/auto-turn.ts` + `vad.ts` (about 30 failing tests, 40+ type errors) next to the wired `turn-taking.ts` + `energy-vad.ts` | Kept the wired design, deleted the dead one and its tests |
| `auto-approval.ts` (the **server** backstop) imported symbols that did not exist and was never called by `/api/approve` | Wired end to end (below) |

**Server backstop.** The browser decides *when* to propose an automatic reply; it no longer is the only thing deciding *what* may be spoken automatically.

- `/api/suggest` now records each candidate's `intent` and `risk` **inside the HMAC-signed candidate proof** (`meta`).
- The timed auto path sends `auto: { mode: 'turn_taking', silenceMs, vetoMs, prefer }` with `/api/approve`. `src/lib/auto-approval.ts` then re-derives everything from the signed proof: unedited AI draft, intent is `continue`/`clarify` (`decline` only if the owner chose the decline style), risk is `none`, no digits/links/commitments/high-stakes words, the partner turn it answers is not sensitive and has at least 3 words, the declared pause and veto windows are in range, and the device is under 10 automatic replies per 5 minutes. Anything else is refused with 403 `auto_not_allowed` (or 429 `auto_rate_limited`). Old proofs without `meta` fail closed.
- "Say it now" is a deliberate human tap, so it is an ordinary manual approval with no `auto` flag.
- The browser picker now also skips drafts containing digits or links, so it never proposes text the server would refuse.
- Shared policy lives in `TURN_TAKING`, `isAutoSpeakable` and `isSensitivePartnerText` (`src/lib/turn-taking.ts`).

**Verification (this pass).**

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` (vitest) | 22 files, 414 tests pass |
| `cd worker && pytest -q` | 117 pass. The two earlier collection errors were only missing `livekit` / `livekit-plugins-assemblyai`; install `worker/requirements-dev.txt` into a venv first |
| `npm run build` (+ `postbuild` secret scan) | pass, no leaks in 41 browser files |
| AssemblyAI key: REST `/v2/transcript` and streaming token mint | 200 |
| `npm run smoke:live` (providers only) | 28/28: all 24 library voices synthesize, Hindi rejected 422, `universal-3-6-pro` STT round trip |
| `npm run smoke:live` against the production build served locally | 41/41, including speak/replay/altered-text/unregistered-clone/device-key checks |
| `npm run smoke:worker` | all pass (plugin TTS to plugin STT to TurnAdapter, revisions strictly increase, one authoritative final) |
| Live `/api/approve` with `auto` and no AI draft | refused `needs_ai_draft`; a forged proof is refused `invalid_proof`; a typed approval still succeeds |

Groq and LiveKit were not configured in this sandbox, so Groq drafting and LiveKit rooms were not exercised live. Their logic is covered by the mocked unit tests.

## 0h. Auto turn-taking + guest-launchable listening (this release)

**Listening is launchable by any visitor.** Browser-direct listening (mic → short-lived AssemblyAI token → streaming STT) is now **ON by default** whenever `ASSEMBLYAI_API_KEY` is set (`REVOICE_ALLOW_BROWSER_STT=false` turns it off). When LiveKit is configured it is tried first; if it cannot start, or its voice worker never joins a tabletop session, the app **automatically falls back to direct listening** and says so. Minutes are still reserved durably, capped and settled per device (see the A-series spend controls). The dead auth leftovers (`/api/account/*`, `AuthControls`, `client/supabase.ts`, `auth-providers.ts`, `auth-note.ts`, `prefs-sync.ts`, `NEXT_PUBLIC_SUPABASE_*`) are deleted; there is no sign-in anywhere.

**Auto turn-taking (opt-in, OFF by default).** A standing, *revocable* delegation, not an autonomous agent:

```
partner stops talking → SilenceTurnDetector (1.5–3.0 s, default 2 s) → Groq draft (3 intent-distinct candidates)
  → pickCandidate (safest suitable one) → VETO COUNTDOWN (2–10 s, default 4 s: Cancel / Say it now)
  → server-signed approval of the EXACT text (same SpeechController path as a typed message) → TTS
```

| Piece | File |
|---|---|
| Pure state machine: `SilenceTurnDetector`, `pickCandidate`, `liveGuard`, `AutoTurnController` | `src/lib/turn-taking.ts` |
| Energy VAD (adaptive noise floor, hysteresis, onset frames, hangover) + throttled `VoiceActivityEmitter` | `src/lib/energy-vad.ts` |
| `onVoiceActivity` wired into `DirectSttListener` (VAD on the captured PCM, never while our own voice plays) and `LiveKitListener` (worker speech-started) | `src/lib/client/listening.ts` |
| Wiring: silence → draft (reuses the draft already made for the final transcript) → countdown → `speech.request()` | `src/components/ReVoiceApp.tsx` |
| UI: settings section, listening card (silence meter, veto countdown, Cancel / Say it now, blocked/cancelled notices), quick chip | `src/components/TurnTakingControls.tsx` |
| Prefs: `autoTurn`, `autoSilenceMs`, `autoVetoMs`, `autoIntent` (sanitised on load: stored data can never switch it on or leave a bound) | `src/components/usePrefs.ts` |

Safety rules enforced (all unit-tested, `tests/turn-taking*.test.ts`, `tests/energy-vad.test.ts`):
- **Nothing is spoken before the veto window has fully elapsed**, and the words are never rewritten: the spoken text must equal the drafted candidate, which goes through a server-signed approval including the candidate proof and the Conversation Brake.
- **Cancelled by:** the Cancel button, Stop / Esc, typing in the message box, touching a suggestion card, the partner speaking again or the transcript changing, going offline, a stale set, turning the setting off, a new session or a reconnect. A cancelled draft is placed in the message box for you to edit.
- **Never auto-replies** to health, legal, money, consent or emergency topics (partner's words *or* the draft), to any draft with a non-`none` risk category, to over-long drafts, or with an affirmative commitment ("yes / sure / I'll be there…"), unless you chose the *decline* style.
- **Dead-man switch:** after 3 automatic replies in a row with no input from you it stops and tells you; any deliberate action (typing, a button, Say it now, Stop) restarts the count.
- **Deaf to itself:** while ReVOICE speaks, and for 1.5 s after, nothing the mic hears counts; the VAD also ignores gated frames.
- Turning it on needs an explicit confirmation and AI suggestions (Groq); turning it off is immediate.
- Honest limits: the VAD cannot tell your partner from music or a TV; the silence clock is a heuristic, so the veto window is the real safeguard. Choose longer windows for slower access methods.

## 0g. No sign-in (this release)

ReVOICE now has **no sign-in of any kind**: no accounts, passwords, OAuth, e-mail links, anonymous-auth provider or guest tier. Every browser is a *device*; the first API call mints a random device id stored in an HMAC-signed, HttpOnly `rv_device` cookie (see `src/lib/server/auth.ts`). That id maps to a deterministic UUID used for budgets, the cloned-voice registry, sessions and the phone bridge. Clearing cookies does not mint a fresh allowance (per-network and project-wide ledgers also apply). To keep a registered cloned voice across browsers, copy the **device key** from Privacy (`GET/POST /api/device`).

Removed in this release: `AuthControls`, `client/supabase.ts`, `auth-providers.ts`, `auth-note.ts`, `prefs-sync.ts`, `/api/account/*` (replaced by `/api/data/export` and `/api/data/delete`), all `NEXT_PUBLIC_SUPABASE_*` variables and the Supabase origins in the CSP. Phrase boards, message bank and preferences live in IndexedDB on the device. Optional operator views use `REVOICE_OPERATOR_TOKEN`; registering a cloned voice can be gated with `REVOICE_CLONE_PASSCODE`.

Verification: `tsc --noEmit` clean, `vitest` 400/400, `next build` + secret scan pass. `vercel.json` is included and verified for Vercel (Next.js framework preset, `npm ci`, `npm run build`).

## 0. Critical bug fixes (B1–B4)

| # | Bug | Fix | Where |
|---|---|---|---|
| B1 | LiveKit tokens passed `canPublishSources: ['microphone']` (string). `livekit-server-sdk@2.19` needs the `TrackSource` enum, so `toJwt()` threw → `/api/livekit/join` empty 500, tabletop start crashed after the room/dispatch/budget were created | Grants use `TrackSource.MICROPHONE`. The owner token is minted **before** the room is created; join/session routes return JSON errors instead of empty 500s | `src/lib/server/livekit.ts`, `src/app/api/livekit/{join,session}/route.ts` |
| B2 | With `REVOICE_APPROVAL_SECRET` unset, every serverless instance invented a random secret → demo identity churn, `bad_signature`, broken invites, worker couldn't verify | One deterministic resolution order shared by web **and** worker: explicit secret → `HMAC-SHA256(LIVEKIT_API_SECRET, label)` → `HMAC-SHA256(ASSEMBLYAI_API_KEY, label)`. Production never uses a random fallback (fails closed). Shared test vector in both test suites | `src/lib/server/env.ts`, `worker/revoice_worker/config.py` |
| B3 | Full 20 listening minutes reserved on every start, never released on end or failure → lockout after 2 sessions | `BudgetLedger.releaseSttMinutes()`. Every failure path in session start refunds the user/project/durable reservations. `/api/livekit/end` commits the elapsed minutes and refunds the rest (idempotent). Replaced sessions are settled too | `src/lib/budget.ts`, `src/lib/server/state.ts`, `src/app/api/livekit/{session,end}/route.ts` |
| B4 | Active-session state only in serverless memory → `wrong_room` on `/api/approve`, `not_your_session` on `/api/livekit/end` (room kept billing) | Stateless **signed session ticket** (`rvs1.<payload>.<hmac>`) issued at start, bound to user + room + conversation + generation + STT reservation, with expiry. The client sends it as `x-revoice-session` (or in the body for `sendBeacon`). Fallbacks: instance cache → LiveKit room metadata (server-set `ownerIdentity`). "One session per user" is checked against LiveKit's room list | `src/lib/session-ticket.ts`, `src/lib/server/session.ts`, `src/app/api/{approve,livekit/*,phone/pair}`, `src/lib/client/api.ts`, `src/components/ReVoiceApp.tsx` |

Regression tests: `tests/bugfixes-b1-b4.test.ts` (web) and `worker/tests/test_worker.py` (B2 vector).

## 0b. Bug fixes B5–B6

| # | Bug | Fix | Where |
|---|---|---|---|
| B5 | Room mode was switched on as soon as the owner device connected to LiveKit, **before the worker joined**. If the agent wasn't deployed, was cold or crashed, every Speak during a session failed with `worker_not_present` — no notice, no timeout — even though HTTP TTS worked | **Worker-presence detection.** `WorkerPresenceMonitor` (`connecting → waiting → ready`, plus `absent` / `lost` / `degraded`) decides the route for each utterance. Speech goes **via the room only while the worker is confirmed** (agent participant present **and** a `ready` status, or 4 s of presence for older workers). Otherwise it goes through `/api/speak` HTTP TTS, so **Speak is never blocked**. Approvals are **route-bound**: room approvals carry `roomName` (checked by the worker), direct approvals carry `roomName = null` (checked by `/api/speak`).<br>**Automatic fallback.** If a room delivery fails **before any audio** (send fails, no acknowledgement within 5 s, or the worker rejects with `bad_signature`), the controller first cancels that attempt at the worker, then speaks the **same frozen text** once over HTTP TTS with a fresh signature. It **never** falls back after audio may have been heard: that stays *Delivery uncertain*, with no automatic replay. User and budget rejections such as `session_char_cap` are **not** bypassed. A held approval whose worker left during the hold is re-signed for the direct route.<br>**UI.** Live badge *Voice worker connected · speech via room / from this device*, plus notices when the worker is absent, lost or back, and a *Worker fallbacks* metric.<br>**Auto-end.** Listening needs the worker. If it never joins (45 s) or leaves and doesn't return (30 s), the session ends automatically: the room is deleted and unused STT minutes are refunded (B3 settlement).<br>**Worker.** Answers a new `hello` control with `ready`, and re-sends `ready` when the owner joins (the first one could go to an empty room) | `src/lib/client/worker-presence.ts` (new), `src/lib/client/speech.ts`, `src/lib/client/listening.ts`, `src/lib/contracts.ts`, `src/components/ReVoiceApp.tsx`, `src/components/MetricsPanel.tsx`, `src/lib/client/metrics.ts`, `worker/revoice_worker/main.py` |
| B6 | Partner-link mode played the synthetic voice on **both** devices. The partner's mic picked up the owner's speaker (each device's echo canceller only removes its own output), so ReVOICE's own speech was transcribed as partner input, breaking architecture rule 5 | **Audio routing policy** (`src/lib/audio-routing.ts`). In partner-link mode the voice plays **only on the partner's phone**. The owner device doesn't attach it, and doesn't even auto-subscribe to room audio; transcripts and status still arrive over data. Tabletop and remote keep their behaviour, and the join page plays only the agent's voice.<br>**Worker echo gate in every mode** (`worker/revoice_worker/echo.py`). Partner audio sent to STT is replaced with silence while the worker speaks, plus a mode-aware tail (0.35 s tabletop, 0.8 s partner-link/remote to cover network playout). Previously this gate only applied to tabletop.<br>**Fallback gating.** While the owner device plays B5 fallback speech, it sends a bounded `gate` control (TTL ≤ 120 s) so the worker treats partner audio as echo; a lost "off" can't mute the partner for good | `src/lib/audio-routing.ts` (new), `src/lib/client/listening.ts`, `src/app/join/page.tsx`, `src/components/ReVoiceApp.tsx`, `worker/revoice_worker/echo.py` (new), `worker/revoice_worker/main.py` |

Regression tests: `tests/bugfixes-b5-b6.test.ts` (20 web tests) and `worker/tests/test_echo_b6.py` (8 worker tests).

**New control messages (owner → worker, `revoice.control`):** `{type:"hello"}` (worker replies with status `ready`) and `{type:"gate", on, ttlMs?}`. Older workers ignore both. The client then falls back to the 4 s presence grace for routing and to its own mic gating, so web and worker can be deployed in either order.

### B5–B6 review: verified and hardened

I re-checked the B5/B6 changes against the bug reports. The presence state machine, route-bound approvals, the pre-audio-only fallback, the partner-link audio policy and the worker echo gate are correct and covered by tests. The review found three gaps, now fixed:

| Gap | Impact | Fix |
|---|---|---|
| Worker **left the room after acknowledging** a room utterance (crash or redeploy mid-speech) | No `done` could ever arrive, so the controller stayed in *Speaking* and every later Speak returned `busy` until the session ended | `SpeechController.onWorkerLeft()`, called when the agent participant disconnects. If nothing was heard yet, it cancels the attempt and speaks the same frozen text once over HTTP TTS. If audio may have been heard, it goes to *Delivery uncertain* with no automatic replay |
| **Remote** mode fallback | The B5 fallback plays on the owner's device, which a remote partner cannot hear, yet the notice said the words were being spoken | `fallbackAudibleToPartner()` / `fallbackNotice()` (`src/lib/audio-routing.ts`). In remote mode the notice says the partner cannot hear it, and a persistent alert (`#remote-fallback-warning`) is shown while speech is routed to this device |
| Stale `roomPending` after a worker `cancelled` / `rejected` / `uncertain` status | A later fallback trigger could act on an utterance that had already finished | Pending room state is cleared on every terminal worker status |

## 0c. Bug fix B7 and the open phone item

| # | Bug | Fix | Where |
|---|---|---|---|
| B7a | Any exception inside a route handler produced Next.js' **empty HTTP 500**. The client could not parse it (the UI showed `http_500`), and nothing was logged | **`withJsonErrors()` wraps every API route** (15 routes, enforced by a test that scans `src/app/api`). Unexpected errors return JSON `{error, message, requestId}` with `no-store`. A missing approval secret in production returns **503 `server_misconfigured`** with the fix in the message, and missing LiveKit config returns 503 `livekit_not_configured`. Every response carries `x-revoice-request-id`. Logs are content-free: route, error class and request id only, never exception messages (they could contain user text) | `src/lib/server/route.ts` (new), all `src/app/api/**/route.ts` |
| B7b | The conversation-mode radio used local state hard-coded to `tabletop`. It **ignored the saved `sessionMode` preference** and never saved a new choice | The mode comes from the preference (`effectiveMode(prefs.sessionMode, livekitAvailable)`), and choosing a mode saves it with `update({ sessionMode })`. Without LiveKit the radio shows tabletop but **keeps** the saved preference, so it comes back once LiveKit is configured. Corrupt values fall back to tabletop | `src/lib/session-mode.ts` (new), `src/components/ReVoiceApp.tsx` |
| B7c | `/favicon.ico` returned 404 (console error on every page) | Real multi-size `favicon.ico` (16–64 px), `apple-touch-icon.png`, 192/512 px PNG manifest icons, all declared in `metadata.icons` and the manifest. The service-worker shell caches the favicon (cache `revoice-shell-v2`) | `public/*`, `src/app/layout.tsx`, `public/manifest.webmanifest`, `public/sw.js` |
| B7d | Session route errors (empty 500s, leaked rooms) | Already fixed with B1/B3 (JSON errors plus room and reservation release on every failure path). B7a now also covers anything unexpected | `src/app/api/livekit/session/route.ts` |
| Open | **Phone pairing worked on one instance only.** Pair codes, bind attempts and call reservations lived in instance memory, so `/api/phone/bind` returned `invalid_code` whenever it reached another instance, and `/api/phone/usage` never settled | The owner room's **server-set LiveKit metadata** is the store across instances (the same source of truth B4 uses for ownership). It holds the **HMAC-hashed** pair code (never the code itself), its expiry, an attempt counter (max 3) and the active call's reservation. Bind finds the code in any live owner room, is single use, and refuses a second concurrent call. Usage reads and clears the reservation on any instance (idempotent). Revoke clears codes in LiveKit as well. Logic is pure over a `RoomMetaStore` interface. The worker's `RoomMeta` ignores the new fields | `src/lib/server/phone-store.ts` (new), `src/lib/server/livekit.ts`, `src/app/api/phone/{pair,bind,usage}/route.ts` |

Regression tests: `tests/bugfixes-b7.test.ts` (17) and `tests/phone-cross-instance.test.ts` (4; each step wipes instance memory to simulate a different serverless instance).

**Totals: 140 web tests across 13 suites, 47 worker tests. All pass.** `tsc --noEmit`, `npm run build` and the secret scan are clean.

**Remaining limits (by design, documented):** LiveKit metadata writes are last-writer-wins. Pair and bind for one owner are serialized by the human flow, so a race can at most grant one extra code guess and can never bypass the HMAC. The monthly phone-minute *counter* is durable only with Supabase (`reservePhoneCallDurable`); without Supabase it is per-instance, as documented for the other in-memory ledgers.

## 0d. Live verification against real providers (B1-B7 audit)

I audited B6, B7 and the open phone item against the **deployed site** (`https://stillmee.vercel.app`) and a **full local stack** (`next start` + a real `livekit-server` + the real Python worker) using the real AssemblyAI key. The key is not stored in the repo; `scripts/live-smoke.mjs` reads it from `ASSEMBLYAI_API_KEY`.

| Check | Result |
|---|---|
| B1 tabletop + partner-link session start, partner join (JWT carries `canPublishSources:["microphone"]`) | pass (live + local) |
| B2 stable secret on Vercel (`approvalSecretSource: derived:LIVEKIT_API_SECRET`); an approval signed on one request verifies on the next | pass |
| B3 STT minutes released/settled on end (reserved 2, committed 1, refunded 1) | pass |
| B4 room approval and room end using only the signed ticket (no instance memory) | pass |
| B5 worker presence: worker `ready` seen in the room; with no worker the session auto-ends and speech still works over HTTP TTS | pass (see "Worker not deployed" below) |
| B6 partner-link: partner can publish mic, owner is never the transcribed track, a partner `speak` control attempt is ignored; replay is `rejected: replayed`; altered text is `rejected: altered_text` | pass (local real worker) |
| B7 JSON errors on routes (`invalid_request`, `unauthorized`, 403/409 bodies); `/favicon.ico` 200; no console errors on the home page | pass |
| Stop mid-speech: worker reports `cancelled`, never `done` | pass |
| AssemblyAI TTS `assemblyai-tts-1`: all 24 library voices synthesize in their listed language; `hindi` is rejected (422) | pass |
| AssemblyAI STT `universal-3-6-pro`: TTS audio to streaming STT returns the same words (EN, ES, DE, FR, IT); `language_codes`, `keyterms_prompt`, `prompt` accepted | pass |
| LiveKit AssemblyAI **plugin** (BYOK) `STT` and `TTS` (synthesize + stream) with the worker's exact parameters | pass |
| Groq `/api/suggest` returns three differentiated candidates; a spoken prompt-injection is treated as data and not obeyed | pass |
| Cloned voice without consent attestation: 403; wrong room: 403; browser STT tokens disabled: 403 | pass |

**Defect found and fixed:** Italian output had **no library voice**, so the wardrobe fell back to a mixed list. The live API showed the built-in voices (`aai-alba`, `aai-eve`) speak Italian and the STT round trip is exact, so Italian now lists them. The wardrobe now lists only voices verified live (added Aaliyah, Kyla, Carrie, Buford, Troy, Malvina, Antonio Luis, Guenther). Tests: `tests/voices.test.ts` (+3).

**Worker not deployed (action for you):** on the live site the LiveKit room is created but no agent joins, because the Python worker is not running on LiveKit Cloud for project `stillme-6jxw4xpq` (or its secrets are missing). Listening and captions cannot work there until it is deployed. Typed speech still works through HTTP TTS, and a session auto-ends after 45 s. Deploy from `worker/` (`lk cloud auth`, `lk agent create`, agent secrets in section 11). The same worker code was confirmed end to end against a local LiveKit server.

**Re-run the live checks any time** (about 75 TTS characters and 10 s of STT, far below the $2 phase-0 envelope):

```
ASSEMBLYAI_API_KEY=... REVOICE_BASE_URL=https://stillmee.vercel.app npm run smoke:live
```

## 0e. Critical security, consent and authorization fixes (B11–B19)

| # | Bug | Fix | Where |
|---|---|---|---|
| B11/B12 | Cloned-voice consent lived only in the browser and was sent to `/api/approve` as a self-made attestation. Anyone could claim **any** voice id of the shared AssemblyAI account; `/api/speak` and session start never looked at the voice | **Server-side voice registry** (`voice_profiles` + append-only `biometric_consents`, service role writes only). The server records consent with its own timestamp, verifies the voice exists with the provider in this data zone, and binds the id to **one** account (first verified claim; revoked/deleted ids stay claimed or tombstoned). `authorizeVoice()` (owner + consent + expiry + revocation + region) runs at **session start, approve, speak and renew**. The client attestation is ignored. Browser IndexedDB is only a display cache synced from `GET /api/voices` | `src/lib/server/voice-registry.ts`, `src/app/api/voices/{route,revoke,renew}`, `src/components/VoiceWardrobe.tsx`, `src/lib/client/db.ts` |
| B13 | Operator check returned `true` for everyone when the allowlist was empty (any account could read project spend and post provider figures); one oversized reconcile figure locked every user out | `isOperator()` **fails closed**; e-mail operators need a confirmed address; reconcile seed is clamped to `[0, total credit]`. The Metrics tab shows the reconcile panel only when the server sends `operator` | `src/lib/server/auth.ts`, `src/lib/reconcile.ts`, `src/app/api/reconcile/route.ts` |
| B14 | Supabase **anonymous** sign-ins got full-account budgets, listening, clones and phone | Anonymous users are **guests** (`guest-anon-…` id, guest ledgers and pool) | `src/lib/server/auth.ts` |
| B15 | `/api/phone/bind` only counted a guess when it matched a live code, so the 10^6 six-digit space could be brute-forced for free | **Every failed bind is counted** per call room (5/10 min), per caller identity (10/60 min) and globally (30/10 min), durably (`guard_hit`, migration 0004). A tripped scope locks and **burns every live pair code**. Locked scopes refuse before the lookup | `src/lib/server/phone-guard.ts`, `src/lib/server/phone-store.ts`, `src/app/api/phone/bind/route.ts` |
| B16 | Room metadata (readable by every participant) held the owner's user id, key terms and context prompt | Server bookkeeping is **AES-256-GCM sealed** (bound to the room); worker configuration travels in the **agent dispatch metadata**; the owner's LiveKit identity is opaque and per room. The worker reads `ownerSub` (approvals) and `ownerIdentity` (control messages) from dispatch metadata only | `src/lib/room-seal.ts`, `src/lib/server/livekit.ts`, `worker/revoice_worker/main.py` |
| B17 | Partner invites were reusable bearer links that carried the owner's user id | Invites carry no user id, have a random id consumed **atomically once** (`consume_invite` RPC; sealed-metadata fallback; fails closed on other errors). The owner mints a fresh link per partner (**New link** button, `POST /api/livekit/invite`) | `src/lib/server/invites.ts`, `src/app/api/livekit/{join,invite}`, `src/components/ReVoiceApp.tsx` |
| B18 | `/api/status` (and `/api/account/export`) gave any caller the internal user id, project budget, lifetime/spendable credit, spend-store mode, approval-secret source and model | Public view = feature flags, region and **the caller's own** daily meters. Everything else is under `operator` (operators only). The export route now uses the same minimal meters (found and fixed while probing the deployed site) | `src/lib/status-view.ts`, `src/app/api/status/route.ts`, `src/app/api/account/export/route.ts` |
| B19 | "Delete account" cleared a cookie and this instance's memory; the auth user, rows, open rooms (still billing STT), reservations and clones survived | **Real deletion**, most dangerous first: tombstone clones → close rooms and settle STT → settle open reservations → delete user rows → delete the Supabase auth user last. Requires `{"confirm":"DELETE MY ACCOUNT"}`; every step is reported; the UI only wipes the device and signs out when the server succeeded. Server-side data export for the signed-in user. Spend history is kept (`on delete set null`) | `src/lib/server/account.ts`, `src/app/api/account/{delete,export}`, `src/components/PrivacyPanel.tsx` |

**Migration `supabase/migrations/0004_security_consent.sql` must be applied** (voice registry columns and one-claim index, `voice_tombstones`, `invite_uses` + `consume_invite`, `guard_events` + `guard_hit`/`guard_count`, `settle_open_reservations`, read-only client policy on `voice_profiles`). Without it cloned voices **fail closed** (`voice_registry_migration_required`) and invites/guards use their documented per-instance fallbacks.

**New environment variables:** `REVOICE_OPERATOR_IDS`, `REVOICE_OPERATOR_EMAILS` (empty = nobody is an operator), `REVOICE_CLONE_REGISTRANTS` (optional), `REVOICE_GUEST_MODE`. See `.env.example`.

Regression tests: `tests/bugfixes-b11-b19.test.ts` (31 tests) and `worker/tests/test_b16_dispatch_meta.py`. Totals now: **191 web tests / 15 suites, 65 worker tests**; `tsc`, `next build` and the secret scan are clean.

## 0e. D-series (Medium: auth, session and client) — bugs #32–#46

| # | Bug | Fix | Where |
|---|---|---|---|
| D32 | Every API call built a new Supabase client and made a network round-trip to validate the token (also on the 20 s status poll) | One client per instance; a verified token is cached for 30 s (never past its own JWT expiry, keyed by SHA-256 so the raw bearer is never stored); concurrent requests share one in-flight check; stale-if-error when Auth is briefly unreachable | `src/lib/server/auth.ts` |
| D33 | A signed-in user whose token went missing silently ran on guest limits | Browser sends `x-revoice-expect-account`; the server labels the guest fallback `x-revoice-auth: missing_token` | `auth.ts`, `auth-note.ts`, `route.ts` |
| D34 | One stale/invalid token was a hard 401 that broke even guest features | Invalid/expired token → labelled capped guest; client refreshes the session and retries **once**; a dead refresh token signs out locally and tells the user; transient errors (429/408/5xx/offline) never sign out | `src/lib/client/api.ts` |
| D35 | Starting a session always sent `replace:true`, silently ending the user's session on another device | Server decides with `planExistingSessions` (own stale room replaced; another device's room = `409 session_active`); the client asks before sending `replace:true` | `session-replace.ts`, `livekit/session/route.ts`, `ReVoiceApp.tsx` |
| D36 | Signing out left a billed listening session running | Sign out ends the session first (token still valid), then drops the account; `SIGNED_OUT` from any source is a safety net | `AuthControls.tsx`, `ReVoiceApp.tsx` |
| D37 | A provider 401 (bad server key) reached the browser as 401 "sign in"; provider 429s looked like our own budget pause | Our own vocabulary: 401/403 → 502 `speech_provider_auth`; 402 → `provider_credit_exhausted`; 429 → `rate_limited`+Retry-After; bad input → 422. **Follow-up (found by the live check):** a network-level failure reaching the provider is now a retryable 502 `speech_provider_unreachable`, and unexpected 500s name the exception *class* (never its message) | `assemblyai.ts`, `speak/route.ts`, `route.ts` |
| D38 | Consent expiry header is epoch **seconds** but was used as milliseconds; real expiry never stored | `parseVoiceExpiryMs` (seconds→ms, tolerant of ms) shared by speak/renew; real expiry persisted | `assemblyai.ts`, `voices.ts`, `voice-registry.ts` |
| D39 | Unregistered/expired clone fell back to Audrey (English) for every output language | `fallbackVoiceFor(language, preferred)` | `voices.ts`, `ReVoiceApp.tsx` |
| D40 | Hold expiry compared the server's `exp` with the device clock | Durations only (`exp − iat` vs. time held on the device) | `shortcuts.ts`, `speech.ts` |
| D41 | Ctrl/Cmd+Enter bypassed the "Speak exactly this?" dialog and double-requested | `ctrlEnterAction` is inert while confirming / in flight / empty | `shortcuts.ts` |
| D42 | Minute counter only moved when something else re-rendered | 15 s tick while a session is active; clamped, never negative | `ReVoiceApp.tsx` |
| D43 | `new Int16Array(buffer, oddOffset)` threw `RangeError` and killed playback; cancelled-attempt set grew forever | `DataView` decode; set capped at 32 | `pcm-player.ts` |
| D44 | Worklet kept every 3rd sample (no low-pass) → aliasing | Hann-windowed-sinc FIR low-pass downsampler; the tested source string **is** the worklet | `downsample.ts`, `listening.ts` |
| D45 | The wait for the SIP caller sat outside `try/finally`, so a no-show left the call room alive | Everything inside `try/finally`; each cleanup step independent | `worker/revoice_worker/main.py` |
| D46 | Phone month total read only per-instance memory (every cold Vercel instance started at 0) | `phoneMonthUsedDurable` reads `phone_month_usage` and uses the instance figure only as a floor (`max`) | `state.ts`, `durable.ts`, phone/reconcile routes |

Regression tests: `tests/bugfixes-d32-d46.test.ts` (69 tests) and `worker/tests/test_d45_call_room_cleanup.py` (6). Totals now: **301 web tests / 17 suites, 117 worker tests**; `tsc`, `next build` and the secret scan are clean. `vercel.json` is asserted by tests (Next.js, `npm ci`, API `maxDuration` 60 ≤ Hobby 300, `no-store` on `/api`, service-worker headers); no Cloudflare/Hono anywhere.

**Live checks (real AssemblyAI key, read from the environment only, never committed):** `npm run smoke:live` — 28/28 provider checks (all 24 library voices synthesize in their language, Hindi rejected 422, universal-3-6-pro STT round trip); `npm run smoke:worker` — all pass (plugin TTS → plugin STT → TurnAdapter, revisions strictly increase, one authoritative final).

**Open item on the deployed site (not caused by D-series code):** against `https://stillmee.vercel.app` `/api/speak` returns an intermittent generic 500 `internal_error` for guests (roughly every other request), while the same build run locally with the same key returned 200 on 12/12 calls and the provider called directly returned 200 on 6/6. The deployed build predates the follow-up above, so the exception class is invisible. After redeploying, the 500 body includes `"kind": "<ExceptionClass>"` and the Vercel function log has the `route_error` line — that identifies it in one request.

## 1. Current status

| Area | State |
|---|---|
| Typed composer, exact-text Speak, always-visible Stop, large text, device-voice fallback | ✅ |
| Local phrase boards (IndexedDB), offline shell (service worker / PWA) | ✅ |
| Approval protocol (HMAC; bound to user, exact NFC text hash, conversation, room, generation, voice, 60 s expiry, single use) | ✅ web and worker, byte-compatible |
| Turn tracking: partial revisions replace earlier ones, Conversation Brake, Turn Passport | ✅ |
| Groq: 3 candidates with different intents in **one** structured-output request, partner speech treated as untrusted input | ✅ |
| Budget ledger: intersecting Groq request, token, per-turn and per-minute limits; TTS characters; STT minutes; $1/day cap; protected $15 reserve | ✅ (in-process; Supabase tables provided) |
| Voice wardrobe: library voices, clone onboarding through the dashboard (provenance and consent), 60-day expiry, affirmative renewal, revoke, fallback voice | ✅ |
| LiveKit session, partner invite, least-privilege tokens, partner join page and coaching view (shows presence only, never drafts) | ✅ |
| Python worker: BYOK STT/TTS, approval check, track filter, Stop/pause, watchdogs, phone binding | ✅ code + 37 pytest |
| Phone bridge: pair code (works across serverless instances via LiveKit room metadata), 40 min/month cap, 15 min/call, worker HMAC; reconciliation route; migration 0002 | ✅ (off by default) |
| Message bank, metrics panel, privacy (export/delete), reconciliation panel | ✅ |
| Vitest: 140 tests across 13 suites (incl. B1–B4, B5–B6, B7 and cross-instance phone regressions) · pytest: 47 worker tests | ✅ all passing |
| Build-time secret scan (fails the build on a leak) | ✅ |
| axe-core WCAG 2.1 AA + best-practice: home, join, dark/reduced-motion, mobile | ✅ 0 violations |
| **Frontend rebuilt (v2 "iridescent glass")**: side rail, animated liquid orb that mirrors listening/drafting/speaking/holding states, quick-action chips, iridescent composer, glass suggestion cards with shimmer while drafting, caption bubbles, tile phrase boards, glass partner join page | ✅ logic unchanged; axe 0 violations on 11 page/mode/viewport cases |
| **Device responsiveness (v2.1)**: labelled sticky tab bar on phones/tablets, fluid type, 2-column quick actions, stacked composer actions, short-landscape mode, safe-area insets (notch/home bar), coarse-pointer 48 px targets, no iOS input zoom, on-screen-keyboard aware viewport | ✅ 0 horizontal overflow, 0 small targets on 9 viewports × 6 panels + join; axe 0 violations on 10 viewport cases |
| `vercel.json` for Vercel deployment | ✅ |
| Live provider smoke test (real AssemblyAI/Groq/LiveKit calls) | ⏳ needs your keys; capped at $2 |
| Usability sessions with consenting non-clinical volunteers | ⏳ not started |

## 2. Entry points

### Pages
| Path | Purpose |
|---|---|
| `/` | User app: composer, Speak/Stop, suggestions, phrase boards, voice wardrobe, settings, message bank, privacy, metrics, phone, reconciliation |
| `/join#<invite>` | Partner page. The invite is in the URL fragment, so it never reaches servers or Referer headers. Partner must give consent; only the microphone is published; coaching view |

### API (all JSON — including unexpected errors: `{error, message, requestId}` + `x-revoice-request-id`; no sign-in: every route identifies the caller by the signed, HttpOnly `rv_device` cookie, minted automatically on first request)
| Method and path | Purpose |
|---|---|
| `GET /api/status` | Identity, provider readiness, budget snapshots, limits |
| `POST /api/approve` | Freeze exact text → signed single-use approval. Rejects altered text, wrong room, unauthorized or expired clones, and stale candidates |
| `POST /api/speak` | Verifies the approval, then streams AssemblyAI HTTP TTS (direct-provider fallback). Rejects altered, replayed, expired and wrong-user approvals |
| `POST /api/suggest` | One Groq call → 3 candidates bound to turn, revision, voice, language and expiry |
| `POST /api/livekit/session` · `POST /api/livekit/end` | Start/end the single active conversation, mint the owner token and partner invite, dispatch the worker |
| `POST /api/livekit/join` | Partner exchanges a signed invite (with consent) for a microphone-only token |
| `POST /api/stt-token` | Temporary AssemblyAI token for browser-direct listening; **on by default**, disable with `REVOICE_ALLOW_BROWSER_STT=false` |
| `POST /api/voices/renew` | Affirmative consent renewal for a cloned voice |
| `POST /api/phone/pair` | Owner creates a 6-digit pair code (needs an active session; phone must be enabled) |
| `POST /api/phone/bind` · `POST /api/phone/usage` | Worker only (HMAC header): bind a caller to the owner room; settle minutes used |
| `GET/POST /api/reconcile` | App estimate vs provider-reported spend |
| `GET /api/account/export` · `POST /api/account/delete` | Export and delete. Deleting here does **not** delete data held by third-party providers |

## 3. Architecture

```
Control plane:  Browser ──► Next.js routes ──► Supabase (optional server-side ledgers/voice registry; no sign-in) · LiveKit server API
Realtime plane: Partner mic ─► LiveKit room ─► Python worker ─► AssemblyAI STT (u3-6-pro)
                                                   │ transcript (data channel) ─► owner UI ─► /api/suggest (Groq)
                owner approves ─► /api/approve ─► signed approval ─► worker re-verifies ─► AssemblyAI TTS ─► room audio
Fallback:       /api/speak (HTTP TTS — automatic when the worker is absent/unresponsive, B5) · device voice · phrase boards · large text · message bank (all work offline/locally)
```

Rules enforced in code and tests:
- No draft text enters TTS before approval (no speculative TTS, no "send and withhold Flush").
- The worker runs no LLM and no `AgentSession`.
- The worker transcribes only the authorized partner microphone (or a phone caller bound by pair code). It never transcribes agent output, and runs at most one stream at a time.
- One utterance at a time.
- Stop silences locally first, then aborts upstream and drops late frames. Speech never resumes on its own.
- Failure after audio has started → **Delivery uncertain**; replay only by explicit user action, with a new approval.
- Provider keys stay server-side. Nothing secret uses the `NEXT_PUBLIC_` prefix, and `scripts/scan-secrets.mjs` fails the build if a secret appears in browser assets.

## 4. Data
- **Durable (optional Supabase, written only by the server with the service role; device-scoped, no accounts):** profiles, accessibility prefs, style cards, voice profiles, biometric consents, phrase boards and phrases, conversation sessions and members, budget reservations, usage events, provider reconciliations, approval uses, content-free audit events, phone pair codes (hashed), phone calls. See `supabase/migrations/0001_init.sql` and `0002_phone_reconcile.sql`.
- **Device (IndexedDB):** phrase boards, prefs, cloned-voice registry and consent events, authorized phrase cache (library voices only), message bank recordings, feedback ("sounds like me" / "not my meaning"), metrics.
- **Memory only:** live transcripts, candidate sets, turn revisions.
- **Never stored:** audio recordings by the app, full transcripts, raw-content logs, clone samples.

## 5. Running it

### Web app (sandbox / any Linux host)
```bash
npm ci
cp .env.example .env.local        # fill in keys; leave blank to run in local-demo mode
npm run build                     # postbuild runs the secret scan
pm2 start ecosystem.config.cjs    # next start on 0.0.0.0:3000
npm test                          # 140 Vitest tests (providers mocked)
```
Without keys the app still runs as a typed AAC tool: phrase boards, large text and device voice. Cloud voice, suggestions and listening show as unavailable.

### Worker
```bash
cd worker && python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest -q                         # 47 tests, no network
# Deploy to LiveKit Cloud Build using worker/Dockerfile; set worker/.env.example values as secrets.
```

### Frontend design system (v2)
- `src/app/globals.css`: tokens (pastel mesh backdrop, frosted glass, iridescent conic border, orb, chips, tiles, bubbles), all inside `@layer components` so Tailwind utilities still win.
- `src/components/ui/Orb.tsx` (CSS-only liquid orb, `Backdrop`, `Logo`), `src/components/ui/Icon.tsx` (inline SVG icons, so there is no icon CDN and it works offline).
- The orb is decorative (`aria-hidden`). Every state also has a text label in the status pills and an `aria-live` caption.
- High contrast (`data-contrast="high"`) swaps all glass for solid black and white with yellow focus. Reduced motion (OS setting or app setting) stops all animation.
- The `--target` and `--text-scale` settings still control every button, chip, tile and rail button.

### Device responsiveness (v2.1)
Presentation-only changes; no app logic changed. Tested in Chromium at 320×568 (iPhone SE), 390×844, 430×932, 844×390 (landscape phone), 600×900 (foldable), 768×1024 / 1024×768 (iPad), 1280×800 and 1920×1080, across every panel and the partner join page.
- **Navigation:** on desktop (≥1024 px) the vertical glass rail stays. Below that, it becomes a sticky, horizontally scrollable tab bar with **visible text labels** (Converse, Voice, Settings, Bank, Privacy, Metrics, Large). On tablets the labels spread evenly. Accessible names contain the visible label (WCAG 2.5.3).
- **Stop:** always fixed at the bottom and on-screen at every size. It respects `env(safe-area-inset-bottom)`, and the page reserves its height (`--dock-reserve`) so it never covers the last content. The fade above it has `pointer-events: none`, so it never swallows taps.
- **Hero:** fluid title; the orb shrinks to 112 px on phones, 64 px in compact panels and 72 px on short landscape screens; the lede is hidden on short screens.
- **Quick actions:** a 2-column grid under 480 px and 1 column under 340 px. Long phrases and voice names truncate instead of overflowing.
- **Composer:** fluid text size and height. Under 640 px, tools (Clear / Large text / counter) sit on one row and **Speak** gets a full-width, taller button. Keyboard hints are hidden on touch-only devices.
- **Suggestions:** one column until 1100 px (three cramped cards on a tablet are hard to read), three above that. Feedback buttons wrap.
- **Touch:** `@media (pointer: coarse)` raises `--target` to at least 48 px; hover lift is disabled on `hover: none`; inputs are ≥16 px so iOS Safari doesn't zoom on focus.
- **Viewport:** `viewport-fit=cover` (safe areas), `interactive-widget=resizes-content` (the on-screen keyboard shrinks the layout, so the composer stays visible), `100dvh` instead of `100vh` (mobile URL bars). Pinch-zoom is never disabled.
- **Short landscape (≤540 px tall):** compact Stop, no rail labels, static rail, smaller orb, shorter composer.
- **Print:** prints only the content (no backdrop, rail or Stop).

### Vercel
`vercel.json` pins the framework (`nextjs`), `npm ci`, `npm run build` (so the secret scan runs on every deploy), the `iad1` region, a 60 s max duration for API routes (within the Hobby limit), `no-store` on `/api/*`, and correct headers for `sw.js` and the manifest. Import the GitHub repo in Vercel, add the env vars from `.env.example` in Project Settings → Environment Variables, and deploy. The Python worker does **not** run on Vercel; it runs on LiveKit Cloud.

### Deployment sequence
1. (Optional) Create a free Supabase project as a **server-side durable store** and apply `supabase/migrations/*.sql` (through `0007_no_signin.sql`). There is no sign-in, no OAuth and no e-mail setup. Without Supabase the app still works, using process memory.
2. Generate one `REVOICE_APPROVAL_SECRET` (it also signs the device cookie).
3. Deploy Next.js to Vercel Hobby (personal, non-commercial use). Set the server env vars there.
4. Deploy the worker to LiveKit Cloud Build. Use the same `REVOICE_APPROVAL_SECRET` as the web app.
5. Add AssemblyAI and Groq keys. Speech goes through BYOK to AssemblyAI, not LiveKit Inference.
6. Run a smoke test of at most **$2**, then reconcile every dashboard on the Reconciliation panel.

## 6. Quotas and headroom (planning figures, not measurements)

| Resource | Allowance | App cap | Headroom |
|---|---|---|---|
| LiveKit agent minutes | 1,000/mo | planned 840 (600 sessions + 200 testing + 40 phone) | 160 |
| LiveKit inbound phone | 50 min/mo (1 US number) | **40 min/mo**, 15 min/call | 10 |
| LiveKit concurrent agent sessions | 5 | 1 active conversation per user | — |
| AssemblyAI credit | $100 existing | $85 spendable; **$15 reserve never auto-spent** | $15 |
| AssemblyAI per day | — | $1, 40 listening min, 20 min/session, 5,000 TTS chars | — |
| Groq per day | account-specific | 200 requests, 100k tokens (≈147 full-size requests), 6/min, 2 per turn, 1 outstanding | — |
| Supabase Free | 500 MB DB; pauses after 7 idle days | metadata only | — |

**These ledgers are application-level, not caps enforced by the providers.** Turn off auto-refill wherever you can and reconcile with the provider dashboards.

## 7. Known limitations
- Single-instance memory stores (replay set, ledgers, sessions) are used unless Supabase service credentials are configured. On serverless or multi-instance hosting, back them with the provided tables.
- Live provider calls were made in the section 0d audit (TTS, STT, Groq, LiveKit). Browser-to-speaker latency targets (<500 ms warm approval-to-audible p50, <150 ms local Stop on real devices) remain **untested**; the worker measured 43-65 ms to first TTS audio in a local room.
- Hindi/Hinglish is supported as STT **input** only. TTS output covers English, Spanish, German, Italian, Portuguese and French only.
- No documented TTS controls for pitch, speed or emotion; ReVOICE does not invent any.
- Clones are created in the AssemblyAI dashboard only; there is no API clone creation. Consent expires 60 days after it was last given and must be renewed affirmatively.
- Camera gaze input is not implemented. Use OS eye-control and switch tools; built-in single-switch scanning is available.
- The phone bridge is off unless `REVOICE_PHONE_INBOUND_ENABLED=true`. Outbound PSTN, paid carriers and emergency calling are permanently disabled. **Not an emergency service.**
- Not for clinical use or real PHI. Supabase Free has no HIPAA support. Medical Mode, ZDR and redaction do not make the application compliant.
- Groq: enable Zero Data Retention in the console. Groq exception logs may otherwise keep content for up to 30 days, and Groq's retained data is US-based.
- Add-ons (diarization, Medical Mode, Guardrails, Speech Understanding, word boundaries, enhanced noise cancellation) and the AssemblyAI LLM Gateway stay **disabled**.

## 8. Rollback
- **Web:** use Vercel "Promote previous deployment", or `git revert <sha>` and redeploy. Every feature commit is separate (`git log --oneline`).
- **Worker:** redeploy the previous image tag on LiveKit Cloud. Stopping the agent leaves typed AAC and HTTP TTS working.
- **Kill switches (env, no code change):** remove `GROQ_API_KEY` to turn suggestions off; remove `LIVEKIT_*` to turn listening off (typed speech keeps working); set `REVOICE_PHONE_INBOUND_ENABLED=false` to turn the phone bridge off; remove `ASSEMBLYAI_API_KEY` to fall back to the device voice only.
- **DB:** migrations are additive (`create table if not exists`). To roll back 0002, drop `phone_pair_codes` and `phone_calls`.

## 9. Owner handover checklist
- [ ] Rotate `REVOICE_APPROVAL_SECRET` (32+ random bytes) and keep the web and worker copies identical. (If unset, both sides derive the same secret from `LIVEKIT_API_SECRET` — see B2 below. Production never falls back to a random per-instance secret.)
- [ ] Set `REVOICE_OPERATOR_IDS` to restrict who can record reconciliations.
- [ ] Confirm AssemblyAI TTS entitlement, credit balance, region (`us`/`eu`; clones only work in the region where they were created) and turn off auto-refill.
- [ ] Confirm Groq Free access to `openai/gpt-oss-20b`, check the account's rate limits and enable ZDR.
- [ ] Confirm LiveKit Build quotas. Activate the US number only if it costs nothing new.
- [ ] Each month, record provider-reported spend on the Reconciliation panel and investigate any under-count.
- [ ] Run usability sessions with consenting non-clinical volunteers (keyboard, screen reader, switch, mobile Safari/Chrome).

## 10. Next steps
1. Live smoke test with real keys (≤$2), then measure warm/cold latency and cost per successful turn.
2. Back the replay store and ledgers with Supabase in production (`durable.ts` is already wired when the service key is present).
3. Playwright end-to-end tests in CI (axe is already clean) and screen-reader passes on iOS and Android.
4. Symbol-supported and simplified-language views after individual testing.

## 11. Manual setup — every step you must do yourself (accounts, keys, deploy)

None of these can be done from code. Do them in order. Without any keys the app still runs as a typed AAC tool (phrase boards, large text, device voice). Each key below turns on one more capability.

### Step 0 — Prerequisites
1. Install Node.js 20 or later and Python 3.11 or later.
2. Unzip the project, then in its folder run `npm ci`.
3. Copy `.env.example` to `.env.local` (web app) and `worker/.env.example` to `worker/.env` (worker). Never commit these files; `.gitignore` already excludes them.

### Step 1 — Approval secret (required for production)
1. Generate a random secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Put the same value in `REVOICE_APPROVAL_SECRET` in both `.env.local` and `worker/.env`, and later in Vercel and LiveKit. The web app and worker must match exactly.
3. If you skip this, the web app **and** the worker both derive the same secret as `HMAC-SHA256(LIVEKIT_API_SECRET, "revoice/approval-secret/v1")` (or from `ASSEMBLYAI_API_KEY` if LiveKit is not configured). In production with none of these set, approval endpoints fail closed. `/api/status` reports `approvalSecretSource`.

### Step 2 — Supabase (OPTIONAL server-side store), free
There is **no sign-in anywhere in ReVOICE**. Supabase is only a server-side database for durable budgets, the cloned-voice registry and phone usage. Skip this step entirely for a first run; everything works from process memory (budgets then reset on a cold start).
1. Sign up at https://supabase.com, then choose **New project**.
2. Go to **Project Settings → API** and copy:
   - Project URL → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (**server only**; never put it in a `NEXT_PUBLIC_` variable). The browser never talks to Supabase and no `anon` key is used.
3. Open **SQL Editor**, then paste and run every file in `supabase/migrations/` in order (`0001` … `0007_no_signin.sql`).
4. Free projects pause after 7 idle days. Restore them from the dashboard.

### Step 3 — AssemblyAI (speech-to-text and text-to-speech), BYOK
1. Sign up at https://www.assemblyai.com/dashboard, then open **API Keys** and copy the key into `ASSEMBLYAI_API_KEY` (web and worker).
2. In **Billing**, check your credit balance and **turn off auto-refill**. The app's $1/day cap and $15 reserve are app-level limits only.
3. Confirm your account has TTS access (`assemblyai-tts-1`) and streaming STT (`universal-3-6-pro`).
4. Choose your data zone and set `ASSEMBLYAI_REGION=us` or `eu` in both places. Cloned voices only work in the zone where they were created.
5. Cloned voices (optional): create them **only in the AssemblyAI dashboard**, with the speaker's documented consent, using 10–30 s of clear single-speaker WAV. Then register the voice ID in the app under **Voice wardrobe → Add a cloned voice**. Consent expires after 60 days and must be renewed in the app.

### Step 4 — Groq (the three suggested replies), free tier
1. Sign up at https://console.groq.com, then open **API Keys → Create API Key** and copy it into `GROQ_API_KEY`.
2. Keep `GROQ_MODEL=openai/gpt-oss-20b`, and check that the model appears under **Models** for your account.
3. In **Settings → Data controls**, enable **Zero Data Retention** if it's available.
4. Check your account's rate limits under **Settings → Limits**. The app's own caps are 200 requests/day, 6/min and 100k tokens/day.

### Step 5 — LiveKit Cloud (realtime audio and the Python worker), Build plan
1. Sign up at https://cloud.livekit.io and create a project.
2. In **Settings → Keys**, create a key and copy:
   - WebSocket URL (`wss://<project>.livekit.cloud`) → `LIVEKIT_URL`
   - API key → `LIVEKIT_API_KEY`
   - API secret → `LIVEKIT_API_SECRET`
   Put all three in both `.env.local` and `worker/.env`.
3. Keep `LIVEKIT_AGENT_NAME=revoice-worker` in the worker env. The web app dispatches the worker by this name.
4. Deploy the worker:
   1. Install the LiveKit CLI (https://docs.livekit.io/home/cli/).
   2. Run `lk cloud auth`.
   3. Run `cd worker && lk agent create`. This builds `worker/Dockerfile` on LiveKit Cloud.
   4. Add the `worker/.env` values as agent **secrets**: `ASSEMBLYAI_API_KEY`, `ASSEMBLYAI_REGION`, `LIVEKIT_*`, `REVOICE_APPROVAL_SECRET` and `REVOICE_APP_URL` (your Vercel URL). Use the dashboard or `lk agent update-secrets`.
   5. Redeploy later with `lk agent deploy`.
5. To test the worker locally instead: `cd worker && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt && python -m revoice_worker.main dev`.
6. Phone bridge (optional, off by default): only if a US inbound number costs nothing new on your plan. Set `REVOICE_PHONE_INBOUND_ENABLED=true` in the worker and set up a LiveKit SIP inbound trunk and dispatch rule in the dashboard. It's capped at 40 min/month and 15 min/call. Not an emergency service.

### Step 6 — Run locally
1. Run `npm run build`. The build fails if any secret leaks into browser files.
2. Start it with `npm start` (or `pm2 start ecosystem.config.cjs`), then open http://localhost:3000.
3. Run the tests: `npm test` (414 tests) and `cd worker && pytest -q` (117 tests; install `worker/requirements-dev.txt` first).
4. Microphone and audio need HTTPS or `localhost`. Test on a phone through your deployed Vercel URL.

### Step 7 — Deploy the frontend to Vercel Hobby
1. Push the project to a GitHub repo (for example, your `StillMe` repo).
2. At https://vercel.com/new, import the repo. `vercel.json` already sets the framework, install/build commands, region, function duration and headers.
3. In **Project Settings → Environment Variables**, add every variable from `.env.example` with real values, plus `REVOICE_APPROVAL_SECRET` (recommended) and optionally `REVOICE_OPERATOR_TOKEN` (unlocks spend reconciliation when pasted in Settings → Operator) and `CRON_SECRET` (Vercel Cron for `/api/cron/purge`). No variable may have the `NEXT_PUBLIC_` prefix; the secret scan in `postbuild` fails the build if a secret reaches the browser.
4. Deploy, then put the Vercel URL into:
   - the worker's `REVOICE_APP_URL` secret
5. `REVOICE_ALLOW_BROWSER_STT` defaults to on so guests can listen with only `ASSEMBLYAI_API_KEY`. Each token mint reserves bounded minutes (per device, per IP and project-wide); set it to `false` if you want LiveKit-only listening.

### Step 8 — First live check (budget at most $2)
1. Open the site (no sign-in), type a sentence and press **Speak**. You should hear the AssemblyAI voice.
2. Start a **Partner link** session, open the link on a second phone, give consent, and speak. Captions and three suggestions should appear. Nothing is spoken until you approve.
3. Press **STOP** while it's speaking; audio must stop at once.
4. Compare spend in the AssemblyAI, Groq and LiveKit dashboards with **Metrics & measurements → Reconciliation**.



## Live checks (opt-in, budget-capped; key from the environment ONLY)

```bash
ASSEMBLYAI_API_KEY=... REVOICE_BASE_URL=https://stillmee.vercel.app npm run smoke:live   # provider + deployed-app checks (41)
ASSEMBLYAI_API_KEY=... npm run smoke:worker   # worker plugin TTS -> STT (universal-3-6-pro) -> TurnAdapter on real provider events
```
Last run: smoke:live 41/41 (28/28 provider-only), smoke:worker 5/5 (revisions supersede, single final, authoritative transcript).

## E48: phrase-board two-way sync

Phrase boards stay on-device (IndexedDB, works offline). When the optional server-side store is configured they also sync per device (device cookie, no sign-in) with Supabase (`phrase_boards`, `phrases` from migration 0005).

- Each board/phrase has `updatedAt` and a soft-delete `deletedAt`, so deletions propagate. Last-writer-wins per row; a tie goes to the cloud copy.
- Built-in boards use deterministic ids and `updatedAt: 0`. A fresh device never uploads its defaults, so it can't overwrite cloud data, and two devices never duplicate the defaults.
- Deleting a board tombstones its phrases. A phrase is never uploaded before its board exists in the cloud (foreign key).
- `uses` is a counter. It merges as max() and never counts as an edit.
- A local edit made while a sync is running is kept (race guard), then uploaded on the next pass.
- Cloud rows are validated before use. Timestamps are clamped against future clock skew.
- Failures show in the Phrase boards panel with a Retry button. Free-tier caps (40 boards, 600 phrases) give a clear message.
- The Dexie v3 upgrade re-keys legacy boards and phrases to real UUIDs and stamps user content.
- Code: `src/lib/phrase-sync.ts` (pure logic), `src/components/usePhraseSync.ts`, `src/lib/client/db.ts`. Tests: `tests/phrase-sync-e48.test.ts`.

Verification: `npm test` (329), `pytest` in `worker/` (117), `npm run build`, `npm run smoke:live`, `npm run smoke:worker`. The smoke scripts read `ASSEMBLYAI_API_KEY` from the environment only.
