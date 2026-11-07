'use client'
/**
 * ReVOICE main controller.
 *
 * Partner speaks → STT captions (revisions REPLACE, never append) → Groq drafts 3 intent-distinct
 * suggestions (Turn Passport-bound) → the user edits/approves the EXACT words → TTS speaks them.
 *
 * Partner INPUT state (TurnTracker) and user OUTPUT state (SpeechController) are kept separate.
 * The only path to generated speech is SpeechController.request(), which requires a server-signed
 * approval of the exact displayed text. Local AAC (typing, phrase boards, message bank, device voice)
 * keeps working when any provider fails.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePrefs } from './usePrefs'
import { acceptGeneration } from '@/lib/generation'
import { useScanning } from './useScanning'
import { StatusBar } from './StatusBar'
import { Suggestions } from './Suggestions'
import { PhraseBoards } from './PhraseBoards'
import { VoiceWardrobe } from './VoiceWardrobe'
import { SettingsPanel } from './SettingsPanel'
import { MessageBank } from './MessageBank'
import { PrivacyPanel } from './PrivacyPanel'
import { MetricsPanel } from './MetricsPanel'
import { PhonePanel } from './PhonePanel'
import { ReconcilePanel } from './ReconcilePanel'
import { OperatorAccess } from './OperatorAccess'
import { Icon, type IconName } from './ui/Icon'
import { Backdrop, Logo, Orb, type OrbState } from './ui/Orb'
import { api, ApiError, getSessionTicket, setSessionTicket, type StatusResponse } from '@/lib/client/api'
import { ctrlEnterAction, elapsedMinutes } from '@/lib/shortcuts'
import { db, getCachedAudio, putCachedAudio } from '@/lib/client/db'
import { PcmStreamPlayer } from '@/lib/client/pcm-player'
import { FALLBACK_REJECTIONS, SpeechController, type SpeakSource } from '@/lib/client/speech'
import { DirectSttListener, LiveKitListener, type TurnUpdate } from '@/lib/client/listening'
import { PRESENCE_LABELS, WorkerPresenceMonitor, type PresenceSnapshot } from '@/lib/client/worker-presence'
import { effectiveMode, modeAvailable } from '@/lib/session-mode'
import { fallbackAudibleToPartner, fallbackNotice, OWNER_FALLBACK_GATES_WORKER } from '@/lib/audio-routing'
import { count, noteTts, recordInterval } from '@/lib/client/metrics'
import { FloatingTip, useFloatingTip } from './ui/FloatingTip'
import { TurnTracker, type PartnerTurn } from '@/lib/turns'
import { SerialQueue } from '@/lib/serial-queue'
import { EngageTracker } from '@/lib/engage'
import { CALLS_PER_TURN, finalRetryDelayMs, isRetryableSuggestError, SuggestionGate } from '@/lib/suggest-gate'
import { partnerIsSpeaking, type OutputState } from '@/lib/output-state'
import { CandidateSet as CandidateSetSchema, INPUT_LANGUAGES, type Candidate, type CandidateSet, type TurnRef } from '@/lib/contracts'
import { randomId, sha256Hex } from '@/lib/hash'
import { adoptProviderExpiry, clonedVoiceUsable, fallbackVoiceFor, isLibraryVoice, LIBRARY_VOICES, type ClonedVoiceProfile } from '@/lib/voices'
import { OUTPUT_BCP47 } from '@/lib/languages'
import { TurnTakingCard, TurnTakingSettings } from './TurnTakingControls'
import { AutoTurnController, type AutoPick, type AutoTurnAction, type AutoTurnSnapshot } from '@/lib/turn-taking'

type Tab = 'session' | 'voice' | 'settings' | 'bank' | 'privacy' | 'metrics'
type Mode = 'tabletop' | 'partner-link' | 'remote'
interface Session {
  kind: 'livekit' | 'direct'
  room?: string
  conversationId: string
  generation: number
  invite: string | null
  mode: Mode
  startedAt: number
  maxMinutes: number
  /** A4: the session's OWN signed ticket, captured at start — settlement never depends on the global ticket
   *  (which cleanupSession clears, and which a replacement session overwrites). */
  ticket?: string
  /** A7: browser-direct STT pseudo-session id (sd-…) used to settle its durable reservation. */
  sttSession?: string
}
interface ComposerSource { candidateSetId: string; candidateId: string; turn: TurnRef; original: string; intent: string; proof?: string; draftedFrom: string }
interface HistoryItem { speaker: 'partner' | 'user'; text: string }

const INTENT_ORDER: Record<Candidate['intent'], number> = { continue: 0, clarify: 1, decline: 2, custom: 2 }
const stableOrder = (s: CandidateSet): CandidateSet => ({ ...s, candidates: [...s.candidates].sort((a, b) => INTENT_ORDER[a.intent] - INTENT_ORDER[b.intent]) })
const IDLE_BACKGROUND_END_MS = 3 * 60_000
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function ReVoiceApp() {
  const { prefs, update } = usePrefs()
  useScanning(prefs.scanning, prefs.scanIntervalMs)

  const [tab, setTab] = useState<Tab>('session')
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [online, setOnline] = useState(true)
  const [output, setOutput] = useState<OutputState>({ kind: 'idle' })
  const [composer, setComposer] = useState('')
  const [composerSource, setComposerSource] = useState<ComposerSource | null>(null)
  const [sourceStale, setSourceStale] = useState<string | null>(null)
  const [lastSpoken, setLastSpoken] = useState('')
  const [confirming, setConfirming] = useState<{ text: string; cacheable: boolean; speakNow: boolean } | null>(null)
  const [largeText, setLargeText] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // D #42: the session minute counter used to be recomputed only when something else re-rendered the screen.
  const [clock, setClock] = useState(() => Date.now())

  // partner input
  const [turns, setTurns] = useState<PartnerTurn[]>([])
  const [listening, setListening] = useState<string>('off')
  const [session, setSession] = useState<Session | null>(null)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteMsg, setInviteMsg] = useState<string | null>(null)
  const [partnerPresent, setPartnerPresent] = useState(false)
  // B7: the mode radio reflects (and persists) the saved `sessionMode` preference instead of a hard-coded 'tabletop'.
  const mode: Mode = effectiveMode(prefs.sessionMode, !!status?.providers.livekit)
  const setMode = useCallback((m: Mode) => update({ sessionMode: m }), [update])
  // B5: voice-worker presence → speech route (room vs direct HTTP TTS)
  const [worker, setWorker] = useState<PresenceSnapshot | null>(null)

  // suggestions
  const [set, setSet] = useState<CandidateSet | null>(null)
  const [pending, setPending] = useState<CandidateSet | null>(null)
  const [stale, setStale] = useState<string | null>(null)
  const [suggLoading, setSuggLoading] = useState(false)
  const [suggError, setSuggError] = useState<string | null>(null)

  const [clones, setClones] = useState<ClonedVoiceProfile[]>([])

  // auto turn-taking (opt-in): live snapshot of the pure controller for the status card
  const [autoSnap, setAutoSnap] = useState<AutoTurnSnapshot | null>(null)

  // refs (callbacks from listeners must see current values)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const statusRef = useRef(status)
  statusRef.current = status
  const sessionRef = useRef<Session | null>(null)
  /** A4: the session we are already ending (its own close() events must not trigger a second end). */
  const endedRef = useRef<Session | null>(null)
  const endSessionRef = useRef<((reason: 'user' | 'timeout' | 'budget' | 'idle' | 'error') => Promise<void>) | null>(null)
  const listenerRef = useRef<LiveKitListener | DirectSttListener | null>(null)
  const trackerRef = useRef(new TurnTracker(`local-${randomId(6)}`))
  const setRef = useRef<{ set: CandidateSet; draftedFrom: string; used: boolean } | null>(null)
  const engage = useRef(new EngageTracker())
  const turnQueue = useRef(new SerialQueue())
  const finalRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sttNoticeRef = useRef(false)
  const composerValueRef = useRef('')
  composerValueRef.current = composer
  const [draftTick, setDraftTick] = useState(0)
  const historyRef = useRef<HistoryItem[]>([])
  const gate = useRef(new SuggestionGate())
  const suggAbort = useRef<AbortController | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heldContext = useRef<{ ref: TurnRef; text: string } | null>(null)
  const marks = useRef<Record<string, number>>({})
  const composerSourceRef = useRef<ComposerSource | null>(null)
  composerSourceRef.current = composerSource
  const clonesRef = useRef<ClonedVoiceProfile[]>([])
  clonesRef.current = clones
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hiddenAt = useRef<number | null>(null)
  const presenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const presenceRef = useRef<WorkerPresenceMonitor | null>(null)
  const presenceTick = useRef<ReturnType<typeof setInterval> | null>(null)
  const workerGated = useRef(false)
  const playerRef = useRef<PcmStreamPlayer | null>(null)
  if (!playerRef.current && typeof window !== 'undefined') playerRef.current = new PcmStreamPlayer()
  // auto turn-taking
  const autoRef = useRef<AutoTurnController | null>(null)
  if (!autoRef.current) autoRef.current = new AutoTurnController()
  /** The candidate set the countdown is about to speak from (kept so the server-signed proof travels with the approval). */
  const autoDraftRef = useRef<{ set: CandidateSet; text: string } | null>(null)
  /** The most recent successful draft, so an auto reply REUSES the draft already made for a final transcript (no extra Groq call). */
  const lastDraftRef = useRef<{ set: CandidateSet; turnId: number; hash: string; text: string; final: boolean } | null>(null)
  const autoKeyRef = useRef('')
  const fallbackRef = useRef<((reason: string) => Promise<void>) | null>(null)
  const fallingBack = useRef(false)

  // ---------------------------------------------------------------- voice resolution
  const region = status?.providers.region ?? 'us'
  const voice = useMemo(() => {
    if (isLibraryVoice(prefs.voiceId)) return { id: prefs.voiceId, label: LIBRARY_VOICES.find((v) => v.id === prefs.voiceId)?.name ?? prefs.voiceId, warning: null as string | null, clone: undefined as ClonedVoiceProfile | undefined }
    const c = clones.find((v) => v.voiceId === prefs.voiceId)
    // D #39: the fallback must speak the OUTPUT language (it used to be Audrey/English for every language).
    if (!c) {
      const fbId = fallbackVoiceFor(prefs.outputLanguage)
      const fbName = LIBRARY_VOICES.find((v) => v.id === fbId)?.name ?? fbId
      return { id: fbId, label: `${fbName} (fallback)`, warning: 'Selected voice not registered — using fallback', clone: undefined }
    }
    const u = clonedVoiceUsable(c, region)
    if (!u.ok) {
      const fbId = fallbackVoiceFor(prefs.outputLanguage, c.fallbackVoiceId)
      const fb = LIBRARY_VOICES.find((v) => v.id === fbId)
      return { id: fbId, label: `${fb?.name ?? fbId} (fallback)`, warning: `“${c.label}” disabled (${u.reason.replace(/_/g, ' ')}) — using your chosen fallback voice`, clone: undefined }
    }
    return { id: c.voiceId, label: `${c.label} (synthetic clone)`, warning: u.remindRenewal ? `Consent for “${c.label}” expires ${new Date(u.expiresAt).toLocaleDateString()} — renew in Voice` : null, clone: c }
  }, [prefs.voiceId, prefs.outputLanguage, clones, region])
  const voiceRef = useRef(voice)
  voiceRef.current = voice

  const reloadClones = useCallback(async () => setClones(await db.voices.toArray()), [])
  const reloadClonesRef = useRef(reloadClones)
  reloadClonesRef.current = reloadClones
  useEffect(() => { reloadClones() }, [reloadClones])

  // ---------------------------------------------------------------- status & connectivity
  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status())
    } catch {
      // Offline or the server is briefly unreachable: keep the last known status; typing and phrase boards still work.
    }
  }, [])
  const refreshStatusRef = useRef<(() => Promise<void>) | null>(null)
  refreshStatusRef.current = refreshStatus
  useEffect(() => {
    refreshStatus()
    const t = setInterval(refreshStatus, 20_000)
    const on = () => setOnline(navigator.onLine)
    on()
    window.addEventListener('online', on)
    window.addEventListener('offline', on)
    return () => {
      clearInterval(t)
      window.removeEventListener('online', on)
      window.removeEventListener('offline', on)
    }
  }, [refreshStatus])

  const sessionActive = !!session
  useEffect(() => {
    if (!sessionActive) return
    setClock(Date.now())
    const t = setInterval(() => setClock(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [sessionActive])

  // iOS/Safari audio unlock on first gesture
  useEffect(() => {
    const unlock = () => void playerRef.current?.unlock().catch(() => undefined)
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  // ---------------------------------------------------------------- speech controller
  const speechRef = useRef<SpeechController | null>(null)
  if (!speechRef.current && typeof window !== 'undefined') {
    speechRef.current = new SpeechController({
      sha256: sha256Hex,
      approve: async (text, textHash, source, route, auto) => {
        const s = sessionRef.current
        const p = prefsRef.current
        const v = voiceRef.current
        const r = await api.approve(
          {
            text,
            textHash,
            conversationId: s?.conversationId ?? trackerRef.current.conversationId,
            // B5: bind to the room ONLY when the worker will deliver it; direct HTTP TTS needs roomName=null.
            roomName: route === 'room' && s?.kind === 'livekit' ? s.room : undefined,
            generation: s?.generation ?? 0,
            voiceId: v.id,
            outputLanguage: p.outputLanguage,
            source,
            auto: auto ? { mode: 'turn_taking' as const, silenceMs: p.autoSilenceMs, vetoMs: p.autoVetoMs, prefer: p.autoIntent } : undefined,
          },
          v.clone,
        )
        return r.approval
      },
      directStream: async (approval, text, signal) => {
        const r = await api.speakStream(approval, text, signal)
        // D #38: the provider reports the real consent expiry on every cloned-voice utterance — keep it (it used to be dropped).
        if (r.voiceExpiresAt && !isLibraryVoice(approval.voiceId)) {
          void db.voices.where('voiceId').equals(approval.voiceId).first().then(async (v) => {
            const next = v ? adoptProviderExpiry(v.providerExpiresAt, r.voiceExpiresAt) : undefined
            if (v && next !== undefined) {
              await db.voices.update(v.id, { providerExpiresAt: next })
              await reloadClonesRef.current?.()
            }
          }).catch(() => undefined)
        }
        return r
      },
      room: null,
      player: playerRef.current!,
      cache: {
        get: async (voiceId, language, textHash) => getCachedAudio(voiceId, language, textHash),
        put: async (voiceId, language, textHash, pcm, sampleRate) => putCachedAudio({ voiceId, language, textHash, pcm, sampleRate }, isLibraryVoice(voiceId)),
      },
      // C #26: "said" is committed when audio ACTUALLY starts — not when the request was dispatched, held for a gap or
      // still waiting on the worker (a rejected/held/failed message used to be recorded as spoken and the composer
      // cleared, losing the owner's words).
      onHeard: ({ text, opts }) => {
        count('approvedTurns')
        if (opts.auto) count('autoSpoken')
        const src = opts.source
        if (src) {
          count('aiApproved')
          if (src.edited) count('aiEdited')
          if (setRef.current) setRef.current.used = true
        } else count('typed')
        historyRef.current = [...historyRef.current, { speaker: 'user' as const, text: text.slice(0, 1200) }].slice(-6)
        setLastSpoken(text)
        // Clear the composer only if the owner has not changed it since pressing Speak.
        if (composerValueRef.current === text) {
          setComposer('')
          setComposerSource(null)
          setSourceStale(null)
        }
        engage.current.reset() // C #29
        void refreshStatusRef.current?.()
      },
      onState: (s) => {
        setOutput(s)
        if (s.kind === 'delivery_uncertain') count('uncertain')
        // Echo safety: never let our own synthesized output be transcribed as partner input.
        const l = listenerRef.current
        const gated = s.kind === 'speaking'
        if (l instanceof DirectSttListener) l.gateMic(gated)
        else if (l instanceof LiveKitListener) {
          if (sessionRef.current?.mode === 'tabletop') void l.gateMic(gated)
          // B6: during the B5 HTTP-TTS fallback the voice plays on THIS device, outside the worker's own
          // speech gate → ask the worker to treat partner audio as echo for the duration (+ tail).
          const needGate = OWNER_FALLBACK_GATES_WORKER && gated && speechRef.current?.lastRoute === 'direct'
          if (needGate !== workerGated.current) {
            workerGated.current = needGate
            void l.gateWorker(needGate)
          }
        }
      },
      onRouteFallback: (reason) => {
        presenceRef.current?.degrade(reason)
        if (presenceRef.current) setWorker(presenceRef.current.snapshot())
        count('routeFallbacks') // B5: room delivery failed before audio → HTTP TTS
        setNotice(fallbackNotice(sessionRef.current?.mode ?? 'tabletop', reason))
      },
      onMark: (name, at, info) => {
        const m = marks.current
        const t = performance.now()
        if (name === 'approval') {
          m.approval = t
          if (m.partnerFinal) recordInterval('partner_final_to_user_approval', t - m.partnerFinal)
        } else if (name === 'first_audio' && m.approval) {
          recordInterval(info?.cached ? 'approval_to_first_audio_cached' : info?.warm ? 'approval_to_first_audio_warm' : 'approval_to_first_audio_cold', t - m.approval)
          noteTts()
        } else if (name === 'stop_silenced' && m.stopPressed) {
          recordInterval('stop_to_silence', t - m.stopPressed)
          m.stopPressed = 0
        } else if (name === 'done' && m.approval) {
          recordInterval('approval_to_playback_done', t - m.approval)
        }
        void at
      },
    })
  }
  const speech = speechRef.current

  // ---------------------------------------------------------------- suggestions
  /**
   * `origin`: 'auto' = drafted by the app from a transcript update; 'manual' = the owner pressed Redraft.
   * C #27: a request that produced NO candidates hands its per-turn slot back, and the FINAL request gets one bounded
   * retry after a transient failure. C #28: hitting the per-turn limit is shown to the owner, never swallowed.
   */
  const requestSuggestions = useCallback(async (turn: PartnerTurn, final: boolean, preferredIntent?: string, origin: 'auto' | 'manual' = 'auto'): Promise<'ok' | 'skipped' | 'limit' | 'failed' | 'superseded'> => {
    const p = prefsRef.current
    const st = statusRef.current
    if (!p.aiSuggestions || !st?.providers.groq || !navigator.onLine) return 'skipped'
    const g = gate.current
    if (g.begin(turn.turnId, final, turn.hash) === 'limit') {
      if (origin === 'manual') setSuggError(`Redraft limit reached for this partner turn (${CALLS_PER_TURN} drafts). A new partner turn unlocks more — or write your own words.`)
      setDraftTick((n) => n + 1)
      return 'limit'
    }
    setDraftTick((n) => n + 1)
    suggAbort.current?.abort()
    const ac = new AbortController()
    suggAbort.current = ac
    setSuggLoading(true)
    setSuggError(null)
    const t0 = performance.now()
    const tracker = trackerRef.current
    let produced = false
    try {
      const { set: raw } = await api.suggest(
        {
          turn: tracker.ref(turn),
          partnerText: turn.text,
          final,
          history: historyRef.current.slice(-6),
          styleCard: p.styleCard,
          outputLanguage: p.outputLanguage,
          voiceId: voiceRef.current.id,
          preferredIntent: preferredIntent || undefined,
        },
        ac.signal,
      )
      const parsed = CandidateSetSchema.safeParse(raw) // validate client-side too
      if (!parsed.success) throw new Error('invalid_suggestions')
      produced = true
      recordInterval('suggestion_request_to_ready', performance.now() - t0)
      if (marks.current.partnerFinal && final) recordInterval('partner_final_to_candidates', performance.now() - marks.current.partnerFinal)
      // Drop if the conversation already moved on materially.
      if (tracker.staleness(parsed.data.turn, turn.text)) return 'ok'
      const next = stableOrder(parsed.data)
      lastDraftRef.current = { set: next, turnId: turn.turnId, hash: turn.hash, text: turn.text, final }
      const cur = setRef.current
      if (cur && engage.current.active()) {
        // Selection stability: never move targets under the user's cursor (C #29: only while the engagement lease is live).
        setPending(next)
        pendingDraftedFrom.current = turn.text
      } else {
        if (cur && !cur.used) count('aiRejected')
        setRef.current = { set: next, draftedFrom: turn.text, used: false }
        setSet(next)
        setPending(null)
        setStale(null)
      }
      return 'ok'
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        if (!produced) g.fail(turn.turnId, final, turn.hash)
        return 'superseded'
      }
      const code = e instanceof ApiError ? e.code : (e as Error).message
      if (!produced) g.fail(turn.turnId, final, turn.hash) // C #27: nothing was produced -> the slot comes back
      if (code === 'superseded') return 'superseded' // a newer request replaced this one; it shows its own result
      // C #27: the FINAL transcript's draft gets ONE bounded retry after a transient failure.
      if (final && isRetryableSuggestError(code, !(e instanceof ApiError)) && g.takeFinalRetry(turn.turnId)) {
        const delay = finalRetryDelayMs(e instanceof ApiError && typeof e.body.retryAfterMs === 'number' ? (e.body.retryAfterMs as number) : undefined)
        if (finalRetryTimer.current) clearTimeout(finalRetryTimer.current)
        finalRetryTimer.current = setTimeout(() => {
          finalRetryTimer.current = null
          const latest = trackerRef.current.get(turn.turnId)
          // Only if that turn is still the newest thing the partner said and its final text is unchanged.
          if (latest && latest.endOfTurn && latest.hash === turn.hash && trackerRef.current.latest()?.turnId === turn.turnId) void requestSuggestionsRef.current?.(latest, true, undefined, 'auto')
        }, delay)
        setSuggError(`Suggestions are retrying in ${Math.ceil(delay / 1000)} s…`)
        return 'failed'
      }
      setSuggError(code.startsWith('groq_') || code === 'budget' ? `Suggestions paused (${code.replace(/_/g, ' ')}). Type or use phrases.` : `Suggestions unavailable (${code}). Type or use phrases.`)
      return 'failed'
    } finally {
      if (suggAbort.current === ac) {
        suggAbort.current = null
        setSuggLoading(false)
      }
      setDraftTick((n) => n + 1)
    }
  }, [])
  const requestSuggestionsRef = useRef<typeof requestSuggestions | null>(null)
  requestSuggestionsRef.current = requestSuggestions
  const pendingDraftedFrom = useRef('')

  const scheduleSuggestions = useCallback((turn: PartnerTurn) => {
    const g = gate.current
    if (turn.endOfTurn) {
      if (debounce.current) clearTimeout(debounce.current)
      if (g.alreadyDrafted(turn.turnId, turn.hash)) return // identical to what was already drafted: no extra call
      void requestSuggestions(turn, true)
      return
    }
    // Draft opportunistically from a stable partial (≈1 update/s), at most once per turn before the final.
    if (g.hasProvisionalAttempt(turn.turnId)) return
    if (turn.text.trim().split(/\s+/).length < 6) return
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      const latest = trackerRef.current.get(turn.turnId)
      if (latest && !latest.endOfTurn) void requestSuggestions(latest, false)
    }, 900)
  }, [requestSuggestions])

  // ---------------------------------------------------------------- partner turns (revision-aware)
  const onTurnNow = useCallback(async (t: TurnUpdate) => {
    const tracker = trackerRef.current
    const isNew = !tracker.get(t.turnId)
    // C #30: `apply` ignores a message whose source revision is not newer than the one already applied.
    const { turn, changed } = await tracker.apply(t)
    if (!changed) return
    autoRef.current?.partnerTurn({ turnId: turn.turnId, text: turn.text, endOfTurn: turn.endOfTurn }, Date.now())
    if (isNew) marks.current.firstPartial = performance.now()
    setTurns(tracker.all().slice(-5))

    // Conversation Brake: stale suggestions / held approvals after a material change.
    const cur = setRef.current
    if (cur) {
      const reason = tracker.staleness(cur.set.turn, cur.draftedFrom)
      if (reason) {
        setStale(reason)
        if (composerSourceRef.current?.candidateSetId === cur.set.id) setSourceStale(reason)
      }
    }
    if (heldContext.current && speech?.isHolding) {
      const reason = tracker.staleness(heldContext.current.ref, heldContext.current.text)
      if (reason && speech.contextChanged(reason)) {
        heldContext.current = null
        setNotice(`Held message cancelled: the conversation changed (${reason.replace(/_/g, ' ')}). Review and approve again.`)
      }
    }

    if (turn.endOfTurn) {
      marks.current.partnerFinal = performance.now()
      if (marks.current.firstPartial) recordInterval('partner_first_partial_to_final', marks.current.partnerFinal - marks.current.firstPartial)
      historyRef.current = [...historyRef.current, { speaker: 'partner' as const, text: turn.text.slice(0, 1200) }].slice(-6)
      if (speech?.isHolding) void speech.gap()
    }
    scheduleSuggestions(turn)
  }, [scheduleSuggestions, speech])
  // C #30: turn messages are handled strictly one at a time, in arrival order (the handler awaits a hash; overlapping
  // handlers could finish out of order and let an OLDER revision overwrite a NEWER one).
  const onTurn = useCallback((t: TurnUpdate) => turnQueue.current.push(() => onTurnNow(t)), [onTurnNow])

  // Gap fallback: if a message is held and the partner has gone quiet, release it.
  useEffect(() => {
    const t = setInterval(() => {
      if (speech?.isHolding && !partnerIsSpeaking(trackerRef.current.latest(), Date.now())) void speech.gap()
    }, 500)
    return () => clearInterval(t)
  }, [speech])

  // ---------------------------------------------------------------- auto turn-taking: owner presence + veto
  /** The owner did something deliberate: the dead-man counter of automatic replies restarts. */
  const humanActed = () => autoRef.current?.userInteracted()
  const outputRef = useRef<OutputState>(output)
  outputRef.current = output
  const lastSnapRef = useRef<AutoTurnSnapshot | null>(null)
  /** Push the controller's state to React only when something the owner can SEE changed (the clock ticks 5x/s). */
  const refreshAutoSnap = useCallback(() => {
    const ctl = autoRef.current
    if (!ctl) return
    const next = ctl.snapshot(Date.now())
    const prev = lastSnapRef.current
    if (next.notice?.kind === 'blocked' && prev?.notice?.at !== next.notice.at) count('autoBlocked')
    const same =
      !!prev && prev.enabled === next.enabled && prev.phase === next.phase && prev.consecutive === next.consecutive &&
      prev.pick?.candidateId === next.pick?.candidateId && prev.notice?.at === next.notice?.at && prev.silenceMs === next.silenceMs &&
      Math.abs(prev.silenceProgress - next.silenceProgress) < 0.03 && Math.abs(prev.vetoProgress - next.vetoProgress) < 0.02 &&
      Math.ceil(prev.vetoRemainingMs / 1000) === Math.ceil(next.vetoRemainingMs / 1000)
    if (same) return
    lastSnapRef.current = next
    setAutoSnap(next)
  }, [])
  /** Cancel a drafting/countdown automatic reply. The draft goes into the message box (the owner's own words from there). */
  const autoCancel = useCallback((reason = 'user_cancel') => {
    const ctl = autoRef.current
    if (!ctl) return
    const p = ctl.cancel(reason, Date.now())
    if (p) {
      count('autoCancelled')
      autoDraftRef.current = null
      if (!composerValueRef.current.trim()) {
        setComposer(p.text)
        speech?.edit(p.text)
      }
    }
    refreshAutoSnap()
  }, [speech, refreshAutoSnap])

  // ---------------------------------------------------------------- speaking
  const speakDevice = useCallback((text: string) => {
    if (!('speechSynthesis' in window)) return setNotice('This device has no built-in voice.')
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = OUTPUT_BCP47[prefsRef.current.outputLanguage]
    window.speechSynthesis.speak(u)
    count('approvedTurns')
    count('typed')
  }, [])

  const playCachedOffline = useCallback(async (text: string) => {
    const v = voiceRef.current
    if (!isLibraryVoice(v.id)) return false
    const hit = await getCachedAudio(v.id, prefsRef.current.outputLanguage, await sha256Hex(text))
    if (!hit || !playerRef.current) return false
    await playerRef.current.unlock()
    const id = `cached-${randomId(6)}`
    playerRef.current.begin(id)
    playerRef.current.push(id, new Uint8Array(hit.pcm), hit.sampleRate)
    return true
  }, [])

  const doSpeak = useCallback(async (text: string, opts: { cacheable?: boolean; speakNow?: boolean; confirmed?: boolean } = {}) => {
    if (!text.trim() || !speech) return
    humanActed()
    setNotice(null)
    if (prefsRef.current.confirmBeforeSpeak && !opts.confirmed) {
      setConfirming({ text, cacheable: !!opts.cacheable, speakNow: !!opts.speakNow })
      return
    }
    setConfirming(null)
    if (!navigator.onLine) {
      // Offline: the user's press authorizes local playback of a previously cached library-voice phrase.
      if (opts.cacheable && (await playCachedOffline(text))) return setLastSpoken(text)
      setNotice(prefsRef.current.deviceVoiceFallback ? 'Offline: your ReVOICE voice needs a connection. Use the device voice, large text, or your message bank.' : 'Offline: your ReVOICE voice needs a connection. Use large text or your message bank.')
      return
    }
    const src = composerSourceRef.current
    const useSource = src && !sourceStale && text.trim().length > 0
    const latest = trackerRef.current.latest()
    // C #31: the approval carries the server-signed proof, what the set answered, and the newest turn THIS device holds, so
    // the server can verify (fail-closed, on any instance) that the conversation has not moved on.
    const source: SpeakSource | undefined = useSource
      ? {
          candidateSetId: src.candidateSetId,
          candidateId: src.candidateId,
          turn: src.turn,
          edited: text !== src.original,
          proof: src.proof,
          draftedFrom: src.draftedFrom,
          current: latest ? { turn: trackerRef.current.ref(latest), text: latest.text } : { turn: src.turn, text: src.draftedFrom },
        }
      : undefined
    const partnerSpeaking = !!sessionRef.current && partnerIsSpeaking(latest, Date.now())
    heldContext.current = latest ? { ref: trackerRef.current.ref(latest), text: latest.text } : null
    // C #26: 'spoken' (direct: audio played), 'pending' (room: dispatched to the worker) and 'held' (waiting for a gap)
    // are NOT committed here — the controller's onHeard fires once audio has actually started. A rejected / stopped /
    // failed request leaves the composer exactly as the owner wrote it, so nothing is lost and nothing is recorded as said.
    const r = await speech.request(text, { source, partnerSpeaking, cacheable: opts.cacheable, speakNow: opts.speakNow })
    if (r === 'held') setNotice('Approved — it will be spoken at the next pause. Press “Speak now” to say it immediately.')
    else if (r === 'rejected') setNotice('That message could not be approved, so nothing was spoken. Your words are still in the box.')
  }, [speech, sourceStale, playCachedOffline])

  const stop = useCallback(() => {
    marks.current.stopPressed = performance.now()
    autoCancel('user_stop')
    humanActed()
    speech?.stop()
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    count('stops')
  }, [speech, autoCancel])

  // Global keys: Escape = Stop (always), Ctrl/Cmd+Enter = Speak composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (largeText) setLargeText(false)
        else if (confirming) setConfirming(null)
        else stop()
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        // D #41: inert while the confirmation dialog is open (it used to bypass the confirmation and request twice).
        if (ctrlEnterAction({ confirming: !!confirming, text: composer, requestInFlight: output.kind === 'speaking' }) === 'speak') void doSpeak(composer)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stop, doSpeak, composer, largeText, confirming, output.kind])

  // Partner coaching presence ("composing…", never the draft content).
  const onComposerChange = (v: string) => {
    if (v) humanActed()
    setComposer(v)
    speech?.edit(v)
    const l = listenerRef.current
    if (l instanceof LiveKitListener) {
      void l.presence(v.trim().length > 0)
      if (presenceTimer.current) clearTimeout(presenceTimer.current)
      presenceTimer.current = setTimeout(() => void l.presence(false), 6000)
    }
  }

  const holdMyTurn = () => {
    const l = listenerRef.current
    if (l instanceof LiveKitListener) void l.presence(true, true)
    void doSpeak(prefs.holdTurnPhrase, { speakNow: true, cacheable: true })
  }

  // ---------------------------------------------------------------- auto turn-taking (opt-in, OFF by default)
  /**
   * Draft for the turn the silence detector fired on. REUSES the draft the app already made for the final transcript (the
   * automatic draft starts the moment the turn ends, long before the silence threshold); only asks Groq again when there is none.
   */
  const autoDraft = useCallback(async (turnId: number) => {
    const ctl = autoRef.current
    if (!ctl) return
    const key = String(turnId)
    if (autoKeyRef.current === key) return
    autoKeyRef.current = key
    try {
      const tracker = trackerRef.current
      const turn = tracker.get(turnId)
      const st = statusRef.current
      if (!turn) return ctl.draftFailed('no_turn', 'That turn is gone, so I did not reply.', Date.now())
      if (!prefsRef.current.aiSuggestions || !st?.providers.groq) return ctl.draftFailed('suggestions_off', 'Auto turn-taking needs AI suggestions. Turn them on in Settings.', Date.now())
      const usable = () => {
        const d = lastDraftRef.current
        return d && d.turnId === turnId && d.hash === turn.hash ? d : null
      }
      const deadline = Date.now() + 9000
      let asked = false
      for (;;) {
        const d = usable()
        if (d) {
          const r = ctl.draftReady({ set: d.set, turnId, partnerText: turn.text }, Date.now())
          if (r.ok) autoDraftRef.current = { set: d.set, text: turn.text }
          return
        }
        if (ctl.phase !== 'drafting') return // cancelled / dropped (partner resumed) while waiting
        if (Date.now() > deadline) break
        if (suggAbort.current) { await sleep(250); continue } // a request (the automatic one for the final transcript) is in flight: wait for it
        if (asked) break
        asked = true
        await requestSuggestionsRef.current?.(turn, true, undefined, 'auto')
      }
      ctl.draftFailed('draft_unavailable', 'I could not draft a reply in time, so I did not speak.', Date.now())
    } finally {
      autoKeyRef.current = ''
      refreshAutoSnap()
    }
  }, [refreshAutoSnap])

  /**
   * The veto window elapsed (or the owner pressed "Say it"). The words are NOT spoken yet: they go through the SAME SpeechController
   * request as a typed message — a server-signed approval of the exact text (candidate proof + Conversation Brake verified on the
   * server) — and only then does TTS run. Failure leaves nothing spoken and a visible notice.
   */
  const autoSpeak = useCallback(async (pick: AutoPick, viaSayIt = false) => {
    const ctl = autoRef.current
    if (!ctl || !speech) return
    const done = (r: string) => {
      ctl.speakResult(r, Date.now())
      refreshAutoSnap()
    }
    const d = autoDraftRef.current
    const tracker = trackerRef.current
    const cand = d?.set.candidates.find((c) => c.id === pick.candidateId)
    if (!d || d.set.id !== pick.setId || !cand || cand.text !== pick.text) return done('stale')
    if (!navigator.onLine) return done('offline')
    const latest = tracker.latest()
    if (!latest || tracker.staleness(d.set.turn, d.text)) return done('stale')
    const source: SpeakSource = {
      candidateSetId: d.set.id,
      candidateId: cand.id,
      turn: d.set.turn,
      edited: false,
      proof: d.set.proof,
      draftedFrom: d.text,
      current: { turn: tracker.ref(latest), text: latest.text },
    }
    autoDraftRef.current = null
    setNotice(null)
    const r = await speech.request(cand.text, { source, partnerSpeaking: false, speakNow: true, auto: !viaSayIt })
    done(r)
  }, [speech, refreshAutoSnap])

  const runAutoAction = useCallback((a: AutoTurnAction) => {
    if (a.type === 'draft') void autoDraft(a.turnId)
    else void autoSpeak(a.pick, a.viaSayIt)
  }, [autoDraft, autoSpeak])

  const autoSayIt = useCallback(() => {
    const a = autoRef.current?.sayNow()
    if (a) runAutoAction(a)
    refreshAutoSnap()
  }, [runAutoAction, refreshAutoSnap])

  // Keep the controller in step with the saved preferences (bounds are enforced again inside the controller).
  useEffect(() => {
    autoRef.current?.setConfig({ enabled: prefs.autoTurn, silenceMs: prefs.autoSilenceMs, vetoMs: prefs.autoVetoMs, intent: prefs.autoIntent })
    refreshAutoSnap()
  }, [prefs.autoTurn, prefs.autoSilenceMs, prefs.autoVetoMs, prefs.autoIntent, refreshAutoSnap])

  // The drive loop (5x/s) — only while listening with auto turn-taking switched on.
  useEffect(() => {
    if (!sessionActive || !prefs.autoTurn) return
    const t = setInterval(() => {
      const ctl = autoRef.current
      if (!ctl) return
      const now = Date.now()
      const o = outputRef.current
      const d = autoDraftRef.current
      const fresh = d ? !trackerRef.current.staleness(d.set.turn, d.text) : true
      const a = ctl.tick(now, {
        composerText: composerValueRef.current,
        engaged: engage.current.active(now),
        outputBusy: o.kind === 'speaking' || o.kind === 'approved_pending_gap',
        online: typeof navigator === 'undefined' ? true : navigator.onLine,
        fresh,
      })
      if (a) runAutoAction(a)
      refreshAutoSnap()
    }, 200)
    return () => clearInterval(t)
  }, [sessionActive, prefs.autoTurn, runAutoAction, refreshAutoSnap])

  /** Turning it ON is an explicit, informed decision; OFF is immediate and cancels anything pending. */
  const toggleAuto = useCallback((on: boolean) => {
    if (!on) {
      autoCancel('turned_off')
      update({ autoTurn: false })
      return
    }
    if (!prefsRef.current.aiSuggestions) return setNotice('Auto turn-taking needs AI suggestions. Turn on “Show AI-drafted suggestions” in Settings first.')
    if (!statusRef.current?.providers.groq) return setNotice('Auto turn-taking needs the suggestion service (Groq), which is not configured on this server.')
    const ok = window.confirm('Turn on auto turn-taking?\n\nAfter your partner pauses, ReVOICE will draft a reply and speak it in your voice after a short countdown — unless you cancel it, type, or touch the suggestions.\n\nIt never replies to health, legal, money or consent topics and never agrees to things for you. You can turn it off at any time.')
    if (!ok) return
    update({ autoTurn: true })
    humanActed()
  }, [autoCancel, update])

  // ---------------------------------------------------------------- listening sessions
  const cleanupSession = useCallback(() => {
    if (watchdog.current) clearTimeout(watchdog.current)
    watchdog.current = null
    if (presenceTick.current) clearInterval(presenceTick.current)
    presenceTick.current = null
    presenceRef.current = null
    workerGated.current = false
    speech?.setRouteSource(undefined)
    setWorker(null)
    listenerRef.current = null
    sessionRef.current = null
    setSessionTicket(null) // B4: ticket is only valid for the session it was issued for
    speech?.setRoom(null)
    setSession(null)
    setPartnerPresent(false)
    turnQueue.current.clear() // C #30: turn messages still queued belong to the session that just ended
    if (finalRetryTimer.current) clearTimeout(finalRetryTimer.current)
    finalRetryTimer.current = null
    if (debounce.current) clearTimeout(debounce.current)
    suggAbort.current?.abort()
    engage.current.reset() // C #29
    sttNoticeRef.current = false
    trackerRef.current.bumpGeneration() // invalidates all outstanding candidates/approvals
    gate.current.clear()
    autoRef.current?.reset() // a pending automatic reply answers a conversation that no longer exists
    autoDraftRef.current = null
    lastDraftRef.current = null
    setSet(null)
    setPending(null)
    setRef.current = null
  }, [speech])

  const endSession = useCallback(async (reason: 'user' | 'timeout' | 'budget' | 'idle' | 'error' = 'user') => {
    const s = sessionRef.current
    const l = listenerRef.current
    if (!s && !l) return
    // A4: capture THIS session's ticket before anything can clear or overwrite it.
    const ticket = s?.ticket ?? getSessionTicket()
    endedRef.current = s ?? null // closed events fired by our own close() must not re-enter
    speech?.onRoomLost()
    await l?.close().catch(() => undefined)
    if (s?.kind === 'livekit' && s.room) await api.endSession(s.room, reason, ticket).catch(() => undefined)
    else if (s?.kind === 'direct' && s.sttSession) await api.endSession(s.sttSession, reason, s.ticket ?? null).catch(() => undefined) // A7
    cleanupSession()
    setListening('off')
    if (reason !== 'user') setNotice(`Listening ended (${reason}). Typing and phrases still work.`)
    void refreshStatus()
  }, [cleanupSession, refreshStatus, speech])

  endSessionRef.current = endSession

  const listenerEvents = useMemo(() => ({
    onTurn: (t: TurnUpdate) => void onTurn(t),
    onVoiceActivity: () => autoRef.current?.partnerActivity(Date.now()),
    onSpeechStarted: () => { marks.current.speechStarted = performance.now() },
    onStatus: (s: { state: string; detail?: string }) => {
      setListening(s.state)
      // A4: an unexpected close (network drop, server-side room deletion, STT Termination) must still SETTLE the
      // reservation — previously the client only cleaned up locally and the reservation stayed open until swept.
      if (s.state === 'closed' && sessionRef.current && endedRef.current !== sessionRef.current) {
        void endSessionRef.current?.('error')
        if (s.detail) setNotice(`Listening stopped (${s.detail.replace(/_/g, ' ')}). Press Start listening to begin again — typing and phrases still work.`)
      }
      if (s.state === 'error') setNotice(`Listening error${s.detail ? ` (${s.detail})` : ''}. Typing and phrases still work.`)
    },
    onWorkerStatus: (s: { type: string; playbackAttemptId?: string; reason?: string }) => {
      if (s.type === 'ready' && presenceRef.current) {
        presenceRef.current.workerReady()
        setWorker(presenceRef.current.snapshot())
      }
      // C #20: speech statuses are applied by the controller ONLY when they carry the current attempt's id.
      speech?.onWorkerStatus(s)
      // C #24/#25: session-level statuses drive the listening indicator and tell the owner what the worker is doing.
      if (s.type === 'listening') {
        setListening('listening')
        if (sttNoticeRef.current) {
          sttNoticeRef.current = false
          setNotice('Listening is back.')
        }
      } else if (s.type === 'reconnecting') {
        setListening('reconnecting')
        sttNoticeRef.current = true
        setNotice('Transcription lost its connection — reconnecting automatically…')
      } else if (s.type === 'paused') {
        if (s.reason?.startsWith('budget')) void endSession('budget')
        else {
          setListening('paused')
          if (s.reason === 'idle') setNotice('Listening paused after a quiet spell. It resumes by itself when your partner speaks again, or press Resume.')
          else if (s.reason === 'stt_failed') setNotice('Transcription could not reconnect after several tries. Press Resume listening to try again — typing and phrases still work.')
        }
      }
      if (s.type === 'ended') void endSession(s.reason === 'timeout' ? 'timeout' : 'idle')
      // B5: rejections that trigger the automatic HTTP-TTS fallback are announced by onRouteFallback instead.
      if (s.type === 'rejected' && !FALLBACK_REJECTIONS.has(s.reason ?? '')) setNotice(`The voice worker refused that message (${s.reason ?? 'rejected'}). Nothing was spoken.`)
    },
    // F: the owner's room connection came back after a gap. Everything drafted/approved before it may answer words the owner never
    // saw, so ask the SERVER for the next generation (monotonic), adopt it locally, and forward it to the worker. Old candidates
    // and approvals become stale on BOTH sides; nothing is replayed.
    onReconnected: () => {
      const cur = sessionRef.current
      if (!cur || cur.kind !== 'livekit' || !cur.room) return
      const room = cur.room
      void api.bumpGeneration(room, cur.ticket ?? getSessionTicket()).then(async (r) => {
        const s = sessionRef.current
        if (!s || s.room !== room || !acceptGeneration(s.generation, r.generation)) return
        s.generation = r.generation
        s.ticket = r.ticket
        setSessionTicket(r.ticket)
        trackerRef.current.setGeneration(r.generation)
        gate.current.clear()
        autoRef.current?.reset()
        autoDraftRef.current = null
        lastDraftRef.current = null
        turnQueue.current.clear()
        suggAbort.current?.abort()
        setSet(null)
        setPending(null)
        setRef.current = null
        setSession({ ...s })
        await (listenerRef.current as LiveKitListener | null)?.sendGeneration?.(r.generation)
        setNotice('Your connection was restored. Earlier suggestions were cleared because you may have missed some of what was said.')
      }).catch(() => undefined)
    },
    onPartnerPresence: (p: boolean) => setPartnerPresent(p),
    onAgentPresence: (present: boolean) => {
      const m = presenceRef.current
      if (!m) return
      if (present) m.agentJoined()
      else {
        m.agentLeft()
        // B5 hardening: an in-flight room utterance can never complete once the worker is gone. Nothing heard →
        // same frozen text once via HTTP TTS; possibly heard → Delivery uncertain (no automatic replay).
        void speech?.onWorkerLeft().then((r) => {
          if (r === 'uncertain') setNotice('The voice worker disconnected while speaking. Part of your message may have been heard — check before repeating it.')
        })
      }
      setWorker(m.snapshot())
    },
  }), [onTurn, speech, cleanupSession, endSession])

  /** Listening via the LiveKit worker. 'failed' = could not start (the caller may fall back to direct listening). */
  const startLivekitSession = async (): Promise<'started' | 'cancelled' | 'failed'> => {
    const prefs = prefsRef.current
    const inputLanguages = prefs.inputLanguages.filter((c): c is (typeof INPUT_LANGUAGES)[number] => (INPUT_LANGUAGES as readonly string[]).includes(c))
    const mode: Mode = effectiveMode(prefs.sessionMode, true)
    const voice = voiceRef.current
    try {
        // D #35: never end another device's session silently. First try WITHOUT replace; if the server reports a live
        // session this device does not hold, ask, and only then repeat with replace.
        const startBody = { mode, voiceId: voice.id, outputLanguage: prefs.outputLanguage, inputLanguages, keyterms: prefs.keyterms, contextPrompt: prefs.contextPrompt }
        let r: Awaited<ReturnType<typeof api.startSession>>
        try {
          r = await api.startSession({ ...startBody, replace: false })
        } catch (e) {
          if (!(e instanceof ApiError) || e.code !== 'session_active') throw e
          const ok = window.confirm('You already have a listening session running (for example on another device). Starting a new one here will END that session. Continue?')
          if (!ok) {
            setNotice('Listening was not started: your other session is still running.')
            return 'cancelled' as const
          }
          r = await api.startSession({ ...startBody, replace: true })
        }
        setSessionTicket(r.ticket) // B4: signed ticket authorizes approve/end on ANY serverless instance
        endedRef.current = null
        trackerRef.current = new TurnTracker(r.conversationId, 0)
        gate.current.clear()
        engage.current.reset()
        turnQueue.current.clear()
        // B6: the listener applies the per-mode audio routing policy (partner-link: voice only on the partner's phone).
        const l = new LiveKitListener(listenerEvents, { url: r.url, token: r.token, publishMic: mode === 'tabletop', mode })
        listenerRef.current = l
        const s: Session = { kind: 'livekit', room: r.room, conversationId: r.conversationId, generation: 0, invite: r.invite, mode, startedAt: Date.now(), maxMinutes: r.maxSessionMinutes, ticket: r.ticket }
        sessionRef.current = s
        setSession(s)
        // B5: room mode is NOT enabled on connect. Speech stays on direct HTTP TTS until the worker is
        // confirmed present; the monitor also ends the session automatically if no worker ever joins.
        // LiveKit Build can shut an idle agent down: the next session may wait 10-20 s for it to join (quotas-and-limits → Agent cold starts).
        const monitor = new WorkerPresenceMonitor({ joinTimeoutMs: 22_000 })
        presenceRef.current = monitor
        speech?.setRouteSource(() => monitor.route())
        setWorker(monitor.snapshot())
        await l.start()
        speech?.setRoom(l)
        monitor.connected()
        if (l.workerPresent) monitor.agentJoined()
        setWorker(monitor.snapshot())
        let lastState = monitor.state
        let lastHello = Date.now()
        presenceTick.current = setInterval(() => {
          if (presenceRef.current !== monitor) return
          // B5: a degraded/unconfirmed worker can prove itself again by answering a hello with `ready`.
          if ((monitor.state === 'degraded' || monitor.state === 'waiting') && l.workerPresent && Date.now() - lastHello > 10_000) {
            lastHello = Date.now()
            void l.hello()
          }
          const verdict = monitor.tick()
          if (monitor.state !== lastState) {
            const prev = lastState
            lastState = monitor.state
            setWorker(monitor.snapshot())
            if (monitor.state === 'absent' && s.mode === 'tabletop' && statusRef.current?.providers.browserStt) {
              // Guests must always be able to listen: a tabletop session does not need the worker, so switch to direct listening now.
              void fallbackRef.current?.('the voice worker did not join')
            } else if (monitor.state === 'absent') setNotice('The voice worker has not joined. Your approved words will be spoken from this device. Listening needs the worker — the session ends automatically if it does not arrive.')
            else if (monitor.state === 'lost') setNotice('The voice worker disconnected. Speech continues from this device; listening resumes if it reconnects.')
            else if (monitor.state === 'ready' && (prev === 'absent' || prev === 'lost' || prev === 'degraded')) setNotice('The voice worker is connected again. Listening and room speech are back.')
          }
          if (verdict === 'end') {
            if (statusRef.current?.providers.browserStt) void fallbackRef.current?.('no voice worker was available')
            else void endSession('error').then(() => setNotice('Listening ended: no voice worker was available to transcribe, so the room was closed and unused listening minutes were released. Typing, phrases and speech still work.'))
          }
        }, 1000)
        watchdog.current = setTimeout(() => void endSession('timeout'), r.maxSessionMinutes * 60_000)
      return 'started'
    } catch (e) {
      const code = e instanceof ApiError ? e.code : (e as Error).message
      lastStartError.current = code
      const failed = sessionRef.current
      endedRef.current = failed
      await listenerRef.current?.close().catch(() => undefined)
      if (failed?.room) await api.endSession(failed.room, 'error', failed.ticket ?? getSessionTicket()).catch(() => undefined)
      else if (failed?.sttSession) await api.endSession(failed.sttSession, 'error', failed.ticket ?? null).catch(() => undefined) // A7
      cleanupSession()
      setListening('off')
      return 'failed'
    }
  }

  /** Listening straight from this device's microphone (guest-friendly, tabletop only). */
  const startDirectSession = async (): Promise<'started' | 'failed'> => {
    const inputLanguages = prefsRef.current.inputLanguages.filter((c): c is (typeof INPUT_LANGUAGES)[number] => (INPUT_LANGUAGES as readonly string[]).includes(c))
    const prefs = prefsRef.current
    try {
        const conv = randomId(10)
        trackerRef.current = new TurnTracker(conv, 0)
        gate.current.clear()
        let maxMin = 20
        endedRef.current = null
        const s: Session = { kind: 'direct', conversationId: conv, generation: 0, invite: null, mode: 'tabletop', startedAt: Date.now(), maxMinutes: maxMin }
        const l = new DirectSttListener(listenerEvents, async () => {
          const r = await api.sttToken({ sampleRate: 16000, languageCodes: inputLanguages, keyterms: prefs.keyterms, minutes: 20 })
          maxMin = Math.floor(r.maxSessionSeconds / 60)
          // A7: keep the pseudo-session + ticket so ending (or an unexpected close) settles the durable reservation.
          s.sttSession = r.session
          s.ticket = r.ticket
          return r
        })
        listenerRef.current = l
        sessionRef.current = s
        setSession(s)
        await l.start()
        speech?.setRoom(null)
        s.maxMinutes = maxMin
        setSession({ ...s })
        watchdog.current = setTimeout(() => void endSession('timeout'), maxMin * 60_000)
      return 'started'
    } catch (e) {
      const code = e instanceof ApiError ? e.code : (e as Error).message
      lastStartError.current = code
      const failed = sessionRef.current
      endedRef.current = failed
      await listenerRef.current?.close().catch(() => undefined)
      if (failed?.room) await api.endSession(failed.room, 'error', failed.ticket ?? getSessionTicket()).catch(() => undefined)
      else if (failed?.sttSession) await api.endSession(failed.sttSession, 'error', failed.ticket ?? null).catch(() => undefined) // A7
      cleanupSession()
      setListening('off')
      return 'failed'
    }
  }

  const explainStartFailure = (code: string) => {
    const c = code.replace(/_/g, ' ')
    if (/NotAllowed|Permission|denied/i.test(code)) setNotice('The microphone is blocked. Allow microphone access for this site, then press Start listening again. Typing and phrases still work.')
    else if (/NotFound|Devices/i.test(code)) setNotice('No microphone was found. Connect one, then press Start listening again. Typing and phrases still work.')
    else setNotice(`Could not start listening (${c}). Typing and phrases still work.`)
  }

  /**
   * Start listening. ANY visitor (no account) can do this: LiveKit when configured, otherwise — or when LiveKit cannot start —
   * direct browser listening (default on whenever the voice service is configured).
   */
  const startSession = async () => {
    setNotice(null)
    const st = statusRef.current
    if (st?.providers.livekit) {
      const r = await startLivekitSession()
      if (r === 'failed') {
        if (st.providers.browserStt) {
          setNotice(`Room listening is unavailable (${(lastStartError.current ?? 'error').replace(/_/g, ' ')}) — switched to direct listening on this device.`)
          if ((await startDirectSession()) === 'failed') explainStartFailure(lastStartError.current ?? 'error')
        } else explainStartFailure(lastStartError.current ?? 'error')
      }
    } else if (st?.providers.browserStt) {
      if ((await startDirectSession()) === 'failed') explainStartFailure(lastStartError.current ?? 'error')
    } else {
      setNotice('Listening is not configured on this server. Typing, phrases and speech still work.')
    }
  }
  const lastStartError = useRef<string | null>(null)

  // Auto-fallback (task 1): a LiveKit session whose voice worker never arrives is replaced by direct listening, so a guest is never stuck.
  fallbackRef.current = async (reason: string) => {
    if (fallingBack.current) return
    fallingBack.current = true
    try {
      await endSessionRef.current?.('error')
      setNotice(`Switched to direct listening on this device (${reason}).`)
      if ((await startDirectSession()) === 'failed') explainStartFailure(lastStartError.current ?? 'error')
    } finally {
      fallingBack.current = false
    }
  }

  const togglePause = async () => {
    const l = listenerRef.current
    if (l instanceof LiveKitListener) await l.setListening(listening === 'paused')
    else if (l instanceof DirectSttListener) await endSession('user') // direct mode: pausing = disconnecting (stops billing)
  }

  // Close streams on genuine breaks: tab hidden for a long time ends the session; page unload ends it.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) hiddenAt.current = Date.now()
      else {
        if (hiddenAt.current && sessionRef.current && Date.now() - hiddenAt.current > IDLE_BACKGROUND_END_MS) void endSession('idle')
        hiddenAt.current = null
      }
    }
    const bgCheck = setInterval(() => {
      if (hiddenAt.current && sessionRef.current && Date.now() - hiddenAt.current > IDLE_BACKGROUND_END_MS) void endSession('idle')
    }, 30_000)
    const onUnload = () => {
      const s = sessionRef.current
      const room = s?.kind === 'livekit' ? s.room : s?.sttSession // A7: direct sessions are settled too
      if (s && room) navigator.sendBeacon?.('/api/livekit/end', new Blob([JSON.stringify({ room, reason: 'idle', ticket: s.ticket ?? getSessionTicket() ?? undefined })], { type: 'application/json' }))
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pagehide', onUnload)
    return () => {
      clearInterval(bgCheck)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pagehide', onUnload)
    }
  }, [endSession])

  // ---------------------------------------------------------------- suggestion handlers
  const useCandidate = (c: Candidate, s: CandidateSet) => {
    humanActed()
    setComposer(c.text)
    speech?.edit(c.text)
    setComposerSource({ candidateSetId: s.id, candidateId: c.id, turn: s.turn, original: c.text, intent: c.intent, proof: s.proof, draftedFrom: setRef.current?.set.id === s.id ? setRef.current.draftedFrom : (trackerRef.current.get(s.turn.turnId)?.text ?? '') })
    // A card that is already stale stays flagged in the composer: speaking it is then sent as the owner's own words (no AI proof).
    setSourceStale(stale)
    document.getElementById('composer-input')?.focus()
  }
  const acceptPending = () => {
    if (!pending) return
    if (setRef.current && !setRef.current.used) count('aiRejected')
    setRef.current = { set: pending, draftedFrom: pendingDraftedFrom.current, used: false }
    setSet(pending)
    setPending(null)
    setStale(null)
    engage.current.reset() // C #29
  }
  const regenerate = () => {
    humanActed()
    const latest = trackerRef.current.latest()
    if (!latest) return setSuggError('No partner speech yet to draft from.')
    // C #28: a refused redraft is explained (the button is also disabled with a visible count when none are left).
    void requestSuggestions(latest, latest.endOfTurn, prefs.preferredIntent, 'manual')
  }

  // ---------------------------------------------------------------- render
  const latestTurn = turns[turns.length - 1]
  const speaking = output.kind === 'speaking'
  const holding = output.kind === 'approved_pending_gap'
  const cloudVoiceDown = !status?.providers.assemblyai || !online || output.kind === 'error'
  const elapsedMin = session ? elapsedMinutes(session.startedAt, clock, session.maxMinutes) : 0
  // B17: invites are single use — the owner mints a fresh one for each additional partner.
  const newPartnerLink = async () => {
    const cur = sessionRef.current
    if (!cur || cur.kind !== 'livekit' || !cur.room) return
    setInviteBusy(true)
    setInviteMsg(null)
    try {
      const r = await api.newInvite(cur.room, cur.ticket ?? null)
      const next = { ...cur, invite: r.invite }
      sessionRef.current = next
      setSession(next)
    } catch (e) {
      setInviteMsg(e instanceof ApiError ? `Could not create a new link (${e.code}).` : 'Could not create a new link.')
    } finally {
      setInviteBusy(false)
    }
  }
  const inviteUrl = session?.invite ? `${typeof window !== 'undefined' ? window.location.origin : ''}/join#${encodeURIComponent(session.invite)}` : null
  const listenAvailable = !!(status?.providers.livekit || status?.providers.browserStt)
  const orbState: OrbState = !online ? 'offline'
    : speaking ? 'speaking'
      : holding ? 'holding'
        : output.kind === 'delivery_uncertain' || output.kind === 'error' ? 'alert'
          : suggLoading ? 'drafting'
            : listening === 'listening' ? 'listening'
              : 'idle'
  const orbCaption = !online ? 'Offline — phrases, large text and device voice still work'
    : speaking ? 'Speaking your approved words'
      : holding ? 'Approved — waiting for a pause'
        : suggLoading ? 'Drafting options for you'
          : listening === 'listening' ? (partnerPresent ? 'Listening to your partner' : 'Listening')
            : listening === 'paused' ? 'Listening paused'
              : 'Ready when you are'
  const home = tab === 'session'
  const railTip = useFloatingTip()
  const goPanel = (k: Tab) => {
    setTab(k)
    requestAnimationFrame(() => document.getElementById(k === 'session' ? 'composer-input' : `panel-${k}`)?.focus({ preventScroll: false }))
  }

  return (
    <div className="rv-shell relative">
      <Backdrop />
      <div className="rv-layout mx-auto flex max-w-[1500px] flex-col gap-3 sm:gap-4 lg:flex-row lg:gap-6">
        {/* ------------------------------------------------ side rail (desktop) / sticky labelled tab bar (phones & tablets) */}
        <aside className="rv-rail-wrap lg:sticky lg:top-5 lg:h-[calc(100dvh-2.5rem)] lg:self-start">
          <nav aria-label="Panels" className="rv-glass rv-rail h-full">
            <span className="mb-1 hidden lg:block"><Logo /></span>
            <span className="rv-rail-logo lg:hidden"><Logo size={36} /></span>
            <div className="rv-rail-items flex flex-row gap-1 lg:mt-auto lg:flex-col lg:gap-2">
              {RAIL.map(([k, label, icon, short]) => (
                <button key={k} className="rv-rail-btn" aria-current={tab === k ? 'page' : undefined} aria-label={label} onClick={() => goPanel(k)} {...railTip.bind(label)}>
                  <Icon name={icon} size={20} />
                  <span className="rv-rail-label" aria-hidden="true">{short}</span>
                </button>
              ))}
            </div>
            <div className="ml-auto lg:ml-0 lg:mt-auto">
              <button className="rv-rail-btn" aria-label="Show large text for your partner" disabled={!composer.trim() && !lastSpoken} onClick={() => setLargeText(true)} {...railTip.bind('Large text')}>
                <Icon name="expand" size={20} />
                <span className="rv-rail-label" aria-hidden="true">Large</span>
              </button>
            </div>
          </nav>
        </aside>
        <FloatingTip tip={railTip.tip} />

        {/* ------------------------------------------------ main canvas */}
        <main id="revoice-app" className="rv-canvas relative min-w-0 flex-1 overflow-hidden px-3 py-4 sm:px-6 sm:py-6 lg:px-8">
          <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="flex min-w-0 items-center gap-3">
              <div className="min-w-0">
                <p className="text-lg font-extrabold tracking-tight">ReVOICE</p>
                <p className="rv-muted truncate text-xs font-semibold">Human-gated voice · you approve every word</p>
              </div>
            </div>
          </header>

          <div className="mt-4">
            <StatusBar status={status} online={online} output={output} listening={listening} voiceLabel={voice.label} voiceWarning={voice.warning} />
          </div>

          {notice && (
            <p role="alert" className="rv-alert rv-alert-warn rv-pop mt-3">
              <Icon name="alert" size={16} /> <span className="flex-1">{notice}</span>
              <button className="rv-btn text-sm" onClick={() => setNotice(null)}>Dismiss</button>
            </p>
          )}

          {/* ------------------------------------------------ hero + orb */}
          <section aria-labelledby="hero-h" className={`rv-hero grid justify-items-center text-center ${home ? 'mt-5 gap-2 sm:mt-7 sm:gap-3' : 'is-compact mt-4 gap-2 sm:mt-5'}`}>
            <h1 id="hero-h" className="rv-hero-title rv-enter">
              <span className="sr-only">ReVOICE: AI listens, you approve every word, your voice speaks.</span>
              <span aria-hidden="true">
                <span className="rv-fade-word">AI Listens.</span> You Approve <span className="rv-fade-word-r">Every</span>
                <br />
                <span className="rv-gradient-text">Word You Speak</span>
              </span>
            </h1>
            {home && <p className="rv-hero-lede rv-muted rv-enter rv-enter-d1 hidden max-w-xl text-base sm:block">Your partner speaks, ReVOICE drafts three options, and nothing is said until you approve the exact words.</p>}
            <div className={`rv-hero-orb rv-enter rv-enter-d2 ${home ? 'my-2 sm:my-3' : 'my-1'}`}>
              <Orb state={orbState} size={home ? 150 : 84} reflection={home} />
            </div>
            <p className={`rv-badge rv-enter rv-enter-d2 max-w-full ${orbState === 'speaking' || orbState === 'listening' ? 'rv-badge-brand' : ''} ${home ? 'mt-4 sm:mt-5' : 'mt-1'}`} aria-live="polite">
              {orbState === 'speaking' || orbState === 'listening' ? <span className="rv-eq" aria-hidden="true"><i /><i /><i /><i /></span> : <Icon name="sparkle" size={13} />}
              {orbCaption}
            </p>
          </section>

          {/* ------------------------------------------------ quick-action chips */}
          <div className="rv-quick rv-enter rv-enter-d3 mx-auto mt-4 flex max-w-3xl flex-wrap justify-center gap-2" role="group" aria-label="Quick actions">
            {!session ? (
              <button data-scan className="rv-chip" onClick={() => { setTab('session'); void startSession() }} disabled={!online || !listenAvailable}>
                <Icon name="headphones" size={15} /> Start listening
              </button>
            ) : (
              <button data-scan className="rv-chip" aria-pressed={listening === 'listening'} onClick={togglePause}>
                <Icon name={listening === 'paused' ? 'play' : 'pause'} size={14} /> {listening === 'paused' ? 'Resume listening' : 'Pause listening'}
              </button>
            )}
            <button data-scan className="rv-chip" id="auto-turn-chip" aria-pressed={prefs.autoTurn} onClick={() => toggleAuto(!prefs.autoTurn)} title="Auto turn-taking: reply after your partner pauses (you can cancel every reply)">
              <Icon name="clock" size={15} /> Auto turn-taking: {prefs.autoTurn ? 'on' : 'off'}
            </button>
            <button data-scan className="rv-chip rv-chip-quote" disabled={speaking} onClick={holdMyTurn} title="Speaks your Hold My Turn phrase now">
              <Icon name="hand" size={15} /> <span className="truncate">“{prefs.holdTurnPhrase}”</span>
            </button>
            <button className="rv-chip" onClick={() => { setTab('session'); requestAnimationFrame(() => document.getElementById('phrase-boards')?.scrollIntoView({ behavior: 'smooth', block: 'start' })) }}>
              <Icon name="grid" size={15} /> Phrase boards
            </button>
            <button className="rv-chip rv-chip-quote" onClick={() => goPanel('voice')}>
              <Icon name="voice" size={15} /> <span className="truncate">{voice.label}</span>
            </button>
          </div>

          {/* ------------------------------------------------ composer (the "ask me anything" card) */}
          <section id="composer" aria-labelledby="composer-h" className="rv-enter rv-enter-d4 mx-auto mt-4 grid w-full max-w-3xl gap-3">
            <h2 id="composer-h" className="sr-only">Your message</h2>
            {composerSource && (
              <p className={`rv-badge rv-badge-wrap self-start ${sourceStale ? 'rv-badge-warn' : 'rv-badge-brand'}`}>
                {sourceStale ? <><Icon name="alert" size={13} /> Context changed since this suggestion ({sourceStale.replace(/_/g, ' ')}). If you speak it, it is sent as your own words.</> : <><Icon name="link" size={13} /> From suggestion ({composerSource.intent}) · answers turn #{composerSource.turn.turnId}{composer !== composerSource.original ? ' · edited' : ''}</>}
              </p>
            )}
            <div className={`rv-iris ${speaking || suggLoading ? 'is-active' : ''}`}>
              <div className="rv-iris-inner">
                <label htmlFor="composer-input" className="sr-only">Message to speak</label>
                <textarea
                  id="composer-input"
                  className="rv-composer-text"
                  value={composer}
                  maxLength={1000}
                  placeholder="Type what you want to say…"
                  onChange={(e) => onComposerChange(e.target.value)}
                  aria-describedby="composer-help"
                />
                <div className="rv-composer-bar">
                  <div className="rv-composer-tools">
                    <button className="rv-chip" disabled={!composer} onClick={() => { setComposer(''); setComposerSource(null); setSourceStale(null); speech?.edit('') }}>
                      <Icon name="x" size={14} /> Clear
                    </button>
                    <button data-scan className="rv-chip" disabled={!composer.trim() && !lastSpoken} onClick={() => setLargeText(true)}>
                      <Icon name="type" size={14} /> <span className="sm:hidden">Large text</span><span className="hidden sm:inline">Show large text</span>
                    </button>
                    <span className="rv-muted ml-auto text-xs tabular-nums sm:ml-0" aria-hidden="true">{composer.length}/1000</span>
                  </div>
                  <div className="rv-composer-actions">
                    {prefs.deviceVoiceFallback && cloudVoiceDown && (
                      <button data-scan className="rv-btn text-sm" disabled={!composer.trim()} onClick={() => speakDevice(composer)} title="Uses this device's built-in voice, not your ReVOICE voice">
                        <Icon name="voice" size={15} /> <span className="sm:hidden">Device voice</span><span className="hidden sm:inline">Speak with device voice</span>
                      </button>
                    )}
                    <button data-scan className="rv-btn rv-btn-primary rv-speak px-6 text-lg" disabled={!composer.trim() || speaking} onClick={() => void doSpeak(composer)}>
                      <Icon name="send" size={17} /> Speak
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <p id="composer-help" className="rv-muted text-center text-xs">Speak says exactly this text.<span className="rv-kbd-hint"> <kbd className="rv-badge">Ctrl+Enter</kbd> Speak · <kbd className="rv-badge">Esc</kbd> Stop</span></p>

            {confirming && (
              <div role="dialog" aria-modal="false" aria-labelledby="confirm-h" className="rv-glass rv-pop grid gap-3 p-4">
                <h3 id="confirm-h" className="rv-section-title">Speak exactly this?</h3>
                <p className="text-xl font-medium">“{confirming.text}”</p>
                <div className="flex flex-col gap-2 min-[400px]:flex-row">
                  <button data-scan className="rv-btn rv-btn-primary flex-1" autoFocus onClick={() => void doSpeak(confirming.text, { cacheable: confirming.cacheable, speakNow: confirming.speakNow, confirmed: true })}>Yes, speak</button>
                  <button data-scan className="rv-btn flex-1" onClick={() => setConfirming(null)}>No</button>
                </div>
              </div>
            )}
            {holding && (
              <div role="status" className="rv-alert rv-alert-info rv-pop">
                <Icon name="clock" size={16} />
                <span className="min-w-[12rem] flex-1">Approved — waiting for your partner to pause: “{output.text}”</span>
                <button data-scan className="rv-btn rv-btn-primary w-full sm:w-auto" onClick={() => void speech?.speakNow()}>Speak now</button>
              </div>
            )}
            {output.kind === 'delivery_uncertain' && (
              <div role="alert" className="rv-alert rv-alert-warn rv-pop">
                <p className="w-full"><strong>Delivery uncertain.</strong> The connection failed while speaking — your partner may have heard part or none of: “{output.text}”. It will not be replayed automatically.</p>
                <button data-scan className="rv-btn" onClick={() => { const t = output.text; speech?.reset(); void doSpeak(t) }}>Replay (asks for new approval)</button>
                <button className="rv-btn" onClick={() => speech?.reset()}>Dismiss</button>
              </div>
            )}
            {output.kind === 'interrupted' && <p role="status" className="rv-muted text-center text-sm">Stopped. Interrupted messages never resume on their own.</p>}
            {output.kind === 'error' && <p role="alert" className="rv-alert rv-alert-warn">Could not speak ({output.message.replace(/_/g, ' ')}). Nothing was replayed automatically.</p>}
            {output.kind === 'paused_for_budget' && <p role="alert" className="rv-alert rv-alert-warn">Voice paused by the daily budget ({output.reason.replace(/_/g, ' ')}). Use the device voice, large text or your message bank.</p>}
          </section>

          {/* ------------------------------------------------ conversation area */}
          <div className="mx-auto mt-6 grid w-full max-w-6xl gap-4 sm:mt-8">
            {session && (
              <section id="live-captions" aria-labelledby="captions-h" className="rv-glass rv-enter grid gap-3 p-4 sm:p-5">
                <header className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="rv-eyebrow">Live · revisions replace, never append</p>
                    <h2 id="captions-h" className="rv-section-title flex items-center gap-2"><Icon name="mic" size={17} /> Partner captions</h2>
                  </div>
                  <span className="rv-badge">
                    {partnerPresent && <><span className="rv-dot live" style={{ background: 'var(--ok)' }} aria-hidden="true" />Partner connected · </>}
                    {session.mode} · {elapsedMin}/{session.maxMinutes} min
                  </span>
                </header>
                <ol className="grid gap-2" aria-label="Recent partner turns">
                  {turns.map((t) => (
                    <li key={t.turnId} className={`rv-bubble rv-pop break-words ${t.endOfTurn ? '' : 'partial'}`}>
                      {t.text || '…'} {!t.endOfTurn && <span className="sr-only">(still speaking)</span>}
                    </li>
                  ))}
                  {turns.length === 0 && <li className="rv-muted flex items-center gap-2"><span className="rv-eq" aria-hidden="true"><i /><i /><i /><i /></span> Waiting for your partner to speak…</li>}
                </ol>
                <p className="sr-only" aria-live="polite">{latestTurn?.endOfTurn ? `Partner said: ${latestTurn.text}` : ''}</p>
              </section>
            )}

            {session && prefs.autoTurn && (
              <TurnTakingCard snap={autoSnap} onCancel={() => autoCancel('user_cancel')} onSayIt={autoSayIt} onDismiss={() => { autoRef.current?.dismissNotice(); refreshAutoSnap() }} />
            )}

            {prefs.aiSuggestions && session && (
              <Suggestions
                set={set}
                pending={pending}
                stale={stale}
                loading={suggLoading}
                error={suggError}
                passport={set ? { turnId: set.turn.turnId, revision: set.turn.revision, final: set.status === 'final' } : null}
                onEngage={() => engage.current.touch()}
                onUse={useCandidate}
                onAcceptPending={acceptPending}
                onFeedback={(c, verdict) => void db.feedback.add({ id: randomId(8), at: Date.now(), intent: c.intent, verdict, edited: false })}
                onRegenerate={regenerate}
                redraftsLeft={(void draftTick, gate.current.remaining(latestTurn?.turnId))}
                redraftLimit={CALLS_PER_TURN}
                preferredIntent={prefs.preferredIntent}
                setPreferredIntent={(s) => update({ preferredIntent: s })}
              />
            )}

            {/* ------------------------------------------------ active rail view */}
            <div id={`panel-${tab}`} tabIndex={-1} className="grid gap-4 outline-none" aria-label={RAIL.find(([k]) => k === tab)?.[1]}>
              {tab === 'session' && (
                <div className="grid gap-4 min-[1180px]:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
                  <section id="session-panel" aria-labelledby="session-h" className="rv-glass rv-enter grid content-start gap-4 p-4 sm:p-5">
                    <header>
                      <p className="rv-eyebrow">Explicit · bounded · billed by connected time</p>
                      <h2 id="session-h" className="rv-section-title flex items-center gap-2"><Icon name="headphones" size={17} /> Listening session</h2>
                    </header>
                    <p className="rv-muted text-sm">Listening is always explicit, bounded ({status?.budget.limits?.assembly.interactiveSessionMinutes ?? 20} min max), and billed by connected time — pausing disconnects transcription. Your partner must know they are being transcribed.</p>
                    {!session ? (
                      <>
                        <fieldset className="grid gap-2">
                          <legend className="sr-only">Conversation mode</legend>
                          {MODES.map(([k, l, d, icon]) => (
                            <label key={k} className="rv-mode">
                              <input type="radio" name="mode" value={k} checked={mode === k} onChange={() => setMode(k)} disabled={!modeAvailable(k, !!status?.providers.livekit)} />
                              <span className="grid gap-0.5">
                                <span className="flex items-center gap-2 font-bold"><Icon name={icon} size={15} /> {l}</span>
                                <span className="rv-muted text-xs">{d}</span>
                              </span>
                            </label>
                          ))}
                        </fieldset>
                        <button data-scan className="rv-btn rv-btn-primary" onClick={startSession} disabled={!online || !listenAvailable}>
                          <Icon name="headphones" size={17} /> Start listening
                        </button>
                        {status && !listenAvailable && <p className="rv-muted text-sm">Listening is not configured on this server (needs the voice service key, or LiveKit).</p>}
                      </>
                    ) : (
                      <>
                        <p className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="rv-badge rv-badge-brand">State: {listening}</span>
                          <span className="rv-badge">{session.kind === 'livekit' ? 'LiveKit worker' : 'direct (this device)'}</span>
                          {session.kind === 'livekit' && worker && (
                            <span id="worker-presence" className={`rv-badge ${worker.route === 'room' ? 'rv-badge-brand' : ''}`} aria-live="polite" title={worker.reason ?? undefined}>
                              <span className={`rv-dot ${worker.state === 'ready' ? 'live' : ''}`} style={{ background: worker.state === 'ready' ? 'var(--ok)' : worker.state === 'waiting' || worker.state === 'connecting' ? 'var(--warn, #d97706)' : 'var(--danger, #dc2626)' }} aria-hidden="true" />
                              {PRESENCE_LABELS[worker.state]} · speech {worker.route === 'room' ? 'via room' : 'from this device'}
                            </span>
                          )}
                          <span className="rv-badge"><Icon name="clock" size={13} /> ends automatically after {session.maxMinutes} min</span>
                        </p>
                        {session.kind === 'livekit' && session.mode === 'partner-link' && (
                          <p className="rv-muted text-xs">Partner link: your voice plays on your partner&apos;s phone only (not on this device), so their microphone never re-captures it.</p>
                        )}
                        {session.kind === 'livekit' && worker && (worker.state === 'absent' || worker.state === 'lost') && (
                          <p role="status" className="rv-alert rv-alert-warn text-sm">
                            <Icon name="alert" size={15} /> No voice worker — captions are unavailable, but Speak still works from this device. This session ends automatically if the worker does not arrive.
                          </p>
                        )}
                        {session.kind === 'livekit' && worker && worker.route === 'direct' && worker.state !== 'connecting' && !fallbackAudibleToPartner(session.mode) && (
                          <p id="remote-fallback-warning" role="alert" className="rv-alert rv-alert-warn text-sm">
                            <Icon name="alert" size={15} /> Remote call: until the voice worker is connected, Speak plays on this device only. Your remote partner will not hear it.
                          </p>
                        )}
                        {inviteUrl && (
                          <div className="grid gap-1">
                            <label htmlFor="invite-url" className="text-sm font-semibold">Partner link (single use, expires in 30 min)</label>
                            <div className="flex flex-col gap-2 min-[420px]:flex-row">
                              <input id="invite-url" className="rv-input min-w-0 flex-1 text-sm" readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
                              <button className="rv-btn" onClick={() => void navigator.clipboard?.writeText(inviteUrl)}><Icon name="copy" size={15} /> Copy</button>
                              <button id="new-invite-button" className="rv-btn" disabled={inviteBusy} onClick={() => void newPartnerLink()}>New link</button>
                            </div>
                            <p className="rv-muted text-xs">Each link admits one partner. After someone joins, make a new link for the next person.</p>
                            {inviteMsg && <p role="status" className="rv-text-danger text-xs">{inviteMsg}</p>}
                          </div>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <button data-scan className="rv-btn flex-1 sm:flex-none" onClick={togglePause}>
                            <Icon name={listening === 'paused' ? 'play' : 'pause'} size={15} />
                            {listening === 'paused' ? 'Resume listening' : session.kind === 'direct' ? 'Pause (disconnects)' : 'Pause listening'}
                          </button>
                          <button data-scan className="rv-btn rv-btn-danger flex-1 sm:flex-none" onClick={() => void endSession('user')}>End session</button>
                        </div>
                        {session.kind === 'livekit' && status?.providers.phoneInbound && <PhonePanel active={!!session} />}
                      </>
                    )}
                  </section>
                  <PhraseBoards onPick={(text, o) => { setComposer(text); setComposerSource(null); setSourceStale(null); speech?.edit(text); if (o.cacheable) void doSpeak(text, { cacheable: true }) }} cacheAllowed={isLibraryVoice(voice.id)} />
                </div>
              )}
              {tab === 'voice' && <VoiceWardrobe voiceId={prefs.voiceId} outputLanguage={prefs.outputLanguage} region={region} onSelect={(id) => update({ voiceId: id })} onVoicesChanged={reloadClones} />}
              {tab === 'settings' && (
                <div className="grid gap-4">
                  <SettingsPanel prefs={prefs} update={update} />
                  <div className="rv-glass rv-enter p-4 sm:p-5"><TurnTakingSettings prefs={prefs} update={update} onToggle={toggleAuto} /></div>
                  <label className="rv-glass grid gap-2 p-4 text-sm font-semibold sm:p-5">
                    <span className="flex items-center gap-2"><Icon name="hand" size={16} /> “Hold My Turn” phrase (spoken exactly as written when you press it)</span>
                    <input className="rv-input font-normal" maxLength={120} value={prefs.holdTurnPhrase} onChange={(e) => update({ holdTurnPhrase: e.target.value || 'I have something to add.' })} />
                  </label>
                </div>
              )}
              {tab === 'bank' && <MessageBank />}
              {tab === 'privacy' && <PrivacyPanel />}
              {tab === 'metrics' && (<div className="grid gap-4"><MetricsPanel status={status} /><OperatorAccess active={!!status?.operator} onChange={() => void refreshStatus()} />{status?.operator && <ReconcilePanel />}</div>)}
            </div>
          </div>

          <footer className="rv-muted mx-auto mt-6 max-w-3xl text-center text-xs sm:mt-8">
            ReVOICE is an assistive-communication prototype, not a medical device. Do not use with real health information. AI suggestions are drafts; nothing is spoken without your approval of the exact words.
          </footer>
        </main>
      </div>

      {/* ------------------------------------------------ always-visible Stop */}
      <div className="rv-stop-dock fixed inset-x-0 bottom-0 z-40 flex justify-center">
        <button
          id="stop-button"
          data-scan
          className={`rv-btn rv-btn-danger rv-stop w-full max-w-xl ${speaking || holding ? 'is-live' : ''}`}
          onClick={stop}
          aria-label="Stop speaking now (Escape)"
        >
          <Icon name="stop" size={20} /> STOP <span className="truncate">{speaking ? '— speaking' : holding ? '— cancel held' : ''}</span>
        </button>
      </div>

      {largeText && (
        <div role="dialog" aria-modal="true" aria-label="Large text for your partner" className="rv-overlay rv-pop fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 overflow-y-auto p-6 sm:gap-8" onClick={() => setLargeText(false)}>
          <span className="rv-overlay-orb"><Orb state={speaking ? 'speaking' : 'idle'} size={72} reflection={false} /></span>
          <p className="max-w-5xl break-words text-center font-extrabold leading-tight tracking-tight" style={{ fontSize: 'clamp(2rem, min(8vw, 12vh), 6rem)' }}>{composer.trim() || lastSpoken}</p>
          <button className="rv-btn" autoFocus onClick={() => setLargeText(false)}><Icon name="x" size={16} /> Close (Esc)</button>
        </div>
      )}
    </div>
  )
}

/** [tab, accessible name, icon, short visible label used on phones/tablets] */
const RAIL: [Tab, string, IconName, string][] = [
  ['session', 'Converse', 'sparkle', 'Converse'],
  ['voice', 'Voice wardrobe', 'voice', 'Voice'],
  ['settings', 'Settings', 'settings', 'Settings'],
  ['bank', 'Message bank', 'bank', 'Bank'],
  ['privacy', 'Privacy & data', 'shield', 'Privacy'],
  ['metrics', 'Metrics & measurements', 'chart', 'Metrics'],
]
const MODES: [Mode, string, string, IconName][] = [
  ['tabletop', 'Tabletop', 'This device hears your partner and plays your voice.', 'mic'],
  ['partner-link', 'Partner link', 'Partner joins on their phone with a link; cleaner audio separation.', 'link'],
  ['remote', 'Remote call', 'Browser call with a remote partner.', 'globe'],
]

