# ReVOICE — Human-Gated Conversational Voice Prosthesis

**AI listens so the human can speak.** The partner speaks, AssemblyAI transcribes, Groq drafts three editable replies, **the user approves the exact words**, and AssemblyAI speaks only those words.

ReVOICE is an assistive communication (AAC) prototype. It is **not** an autonomous voice agent. A detected pause is not consent, and a plausible reply is not what the user means.

> Stack: Next.js (App Router) · React · TypeScript · Tailwind · Zod · Dexie/IndexedDB · Supabase (auth, minimal DB, RLS) · LiveKit Cloud Build (media and Python worker) · AssemblyAI BYOK (STT `universal-3-6-pro`, TTS `assemblyai-tts-1`) · Groq (`openai/gpt-oss-20b`).
> **Never Cloudflare, never Hono.** Frontend target: Vercel Hobby.

---

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

### API (all JSON — including unexpected errors: `{error, message, requestId}` + `x-revoice-request-id`; user routes need a Supabase bearer token, or the signed demo cookie when Supabase is not configured)
| Method and path | Purpose |
|---|---|
| `GET /api/status` | Identity, provider readiness, budget snapshots, limits |
| `POST /api/approve` | Freeze exact text → signed single-use approval. Rejects altered text, wrong room, unauthorized or expired clones, and stale candidates |
| `POST /api/speak` | Verifies the approval, then streams AssemblyAI HTTP TTS (direct-provider fallback). Rejects altered, replayed, expired and wrong-user approvals |
| `POST /api/suggest` | One Groq call → 3 candidates bound to turn, revision, voice, language and expiry |
| `POST /api/livekit/session` · `POST /api/livekit/end` | Start/end the single active conversation, mint the owner token and partner invite, dispatch the worker |
| `POST /api/livekit/join` | Partner exchanges a signed invite (with consent) for a microphone-only token |
| `POST /api/stt-token` | Temporary AssemblyAI token; **only** if `REVOICE_ALLOW_BROWSER_STT=true` (trusted private demo) |
| `POST /api/voices/renew` | Affirmative consent renewal for a cloned voice |
| `POST /api/phone/pair` | Owner creates a 6-digit pair code (needs an active session; phone must be enabled) |
| `POST /api/phone/bind` · `POST /api/phone/usage` | Worker only (HMAC header): bind a caller to the owner room; settle minutes used |
| `GET/POST /api/reconcile` | App estimate vs provider-reported spend |
| `GET /api/account/export` · `POST /api/account/delete` | Export and delete. Deleting here does **not** delete data held by third-party providers |

## 3. Architecture

```
Control plane:  Browser ──► Next.js routes ──► Supabase (auth/prefs/ledgers) · LiveKit server API
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
- **Durable (Supabase, RLS on every user table):** profiles, accessibility prefs, style cards, voice profiles, biometric consents, phrase boards and phrases, conversation sessions and members, budget reservations, usage events, provider reconciliations, approval uses, content-free audit events, phone pair codes (hashed), phone calls. See `supabase/migrations/0001_init.sql` and `0002_phone_reconcile.sql`.
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
1. Configure a free OAuth provider in Supabase. Do not rely on default SMTP (limited to 2 emails/hour, team addresses only).
2. Apply `supabase/migrations/*.sql`.
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

### Step 2 — Supabase (sign-in and minimal database), free
1. Sign up at https://supabase.com, then choose **New project**. Pick a region and set a database password.
2. Go to **Project Settings → API** and copy:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` public key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (**server only**; never put it in a `NEXT_PUBLIC_` variable)
3. Open **SQL Editor**, then paste and run `supabase/migrations/0001_init.sql`, then `0002_phone_reconcile.sql`, then `0003_spend_control.sql` (A-series budget/spend control; until applied the app falls back to the legacy reserve_budget RPCs and `/api/status` reports `spendStore: "legacy"`).
4. Set up OAuth sign-in. Default email sign-in is limited to 2 emails per hour, so don't rely on it.
   - **GitHub:** at https://github.com/settings/developers choose **New OAuth App**. Set Homepage URL to your site URL, and the callback URL to `https://<your-project-ref>.supabase.co/auth/v1/callback`. Copy the Client ID and Secret into Supabase **Authentication → Providers → GitHub** and enable it.
   - **Google (optional):** in Google Cloud Console go to **APIs & Services → Credentials → Create OAuth client ID** (Web). Use the same Supabase callback URL as the authorized redirect URI. Paste the ID and secret into Supabase **Providers → Google**.
5. In Supabase **Authentication → URL Configuration**, set Site URL to your Vercel URL. Add `http://localhost:3000` and your Vercel URL to Redirect URLs.
6. Note: free projects pause after 7 idle days. Restore them from the dashboard.

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
3. Run the tests: `npm test` (140 tests) and `cd worker && pytest -q` (47 tests).
4. Microphone and audio need HTTPS or `localhost`. Test on a phone through your deployed Vercel URL.

### Step 7 — Deploy the frontend to Vercel Hobby
1. Push the project to a GitHub repo (for example, your `StillMe` repo).
2. At https://vercel.com/new, import the repo. `vercel.json` already sets the framework, install/build commands, region, function duration and headers.
3. In **Project Settings → Environment Variables**, add every variable from `.env.example` with real values, plus `REVOICE_APPROVAL_SECRET` (recommended) and optionally `REVOICE_OPERATOR_IDS` (comma-separated Supabase user IDs allowed to record reconciliations). Only the two `NEXT_PUBLIC_SUPABASE_*` variables may have the public prefix.
4. Deploy, then put the Vercel URL into:
   - Supabase Site URL and Redirect URLs
   - the GitHub/Google OAuth homepage
   - the worker's `REVOICE_APP_URL` secret
5. Keep `REVOICE_ALLOW_BROWSER_STT=false` in production. It's only for a trusted private demo.

### Step 8 — First live check (budget at most $2)
1. Sign in, type a sentence and press **Speak**. You should hear the AssemblyAI voice.
2. Start a **Partner link** session, open the link on a second phone, give consent, and speak. Captions and three suggestions should appear. Nothing is spoken until you approve.
3. Press **STOP** while it's speaking; audio must stop at once.
4. Compare spend in the AssemblyAI, Groq and LiveKit dashboards with **Metrics & measurements → Reconciliation**.

