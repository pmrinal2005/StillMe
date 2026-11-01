# ReVOICE — Human-Gated Conversational Voice Prosthesis

**AI listens so the human can speak.** The partner speaks, AssemblyAI transcribes, Groq drafts three editable replies, **the user approves the exact words**, and AssemblyAI speaks only those words.

ReVOICE is an assistive communication (AAC) prototype. It is **not** an autonomous voice agent. A detected pause is not consent, and a plausible reply is not what the user means.

> Stack: Next.js (App Router) · React · TypeScript · Tailwind · Zod · Dexie/IndexedDB · Supabase (auth, minimal DB, RLS) · LiveKit Cloud Build (media and Python worker) · AssemblyAI BYOK (STT `universal-3-6-pro`, TTS `assemblyai-tts-1`) · Groq (`openai/gpt-oss-20b`).
> **Never Cloudflare, never Hono.** Frontend target: Vercel Hobby.

---

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
| Phone bridge: pair code, 40 min/month cap, 15 min/call, worker HMAC; reconciliation route; migration 0002 | ✅ (off by default) |
| Message bank, metrics panel, privacy (export/delete), reconciliation panel | ✅ |
| Vitest: 77 tests across 9 suites | ✅ all passing |
| Build-time secret scan (fails the build on a leak) | ✅ |
| axe-core WCAG 2.1 AA + best-practice: home, join, dark/reduced-motion, mobile | ✅ 0 violations |
| Live provider smoke test (real AssemblyAI/Groq/LiveKit calls) | ⏳ needs your keys; capped at $2 |
| Usability sessions with consenting non-clinical volunteers | ⏳ not started |

## 2. Entry points

### Pages
| Path | Purpose |
|---|---|
| `/` | User app: composer, Speak/Stop, suggestions, phrase boards, voice wardrobe, settings, message bank, privacy, metrics, phone, reconciliation |
| `/join#<invite>` | Partner page. The invite is in the URL fragment, so it never reaches servers or Referer headers. Partner must give consent; only the microphone is published; coaching view |

### API (all JSON; user routes need a Supabase bearer token, or the signed demo cookie when Supabase is not configured)
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
Fallback:       /api/speak (HTTP TTS) · device voice · phrase boards · large text · message bank (all work offline/locally)
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
npm test                          # 77 Vitest tests (providers mocked)
```
Without keys the app still runs as a typed AAC tool: phrase boards, large text and device voice. Cloud voice, suggestions and listening show as unavailable.

### Worker
```bash
cd worker && python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest -q                         # 37 tests, no network
# Deploy to LiveKit Cloud Build using worker/Dockerfile; set worker/.env.example values as secrets.
```

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
- No live provider calls have been made from this build. Latency targets (<500 ms warm approval-to-audio p50, <150 ms local Stop) are **untested**.
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
- [ ] Rotate `REVOICE_APPROVAL_SECRET` (32+ random bytes) and keep the web and worker copies identical.
- [ ] Set `REVOICE_REQUIRE_SECRET=true` in production.
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

_Last updated: 2026-11-01._
