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
import { Icon, type IconName } from './ui/Icon'
import { Backdrop, Logo, Orb, type OrbState } from './ui/Orb'
import { api, ApiError, getSessionTicket, setSessionTicket, type StatusResponse } from '@/lib/client/api'
import { db, getCachedAudio, putCachedAudio } from '@/lib/client/db'
import { PcmStreamPlayer } from '@/lib/client/pcm-player'
import { FALLBACK_REJECTIONS, SpeechController, type SpeakSource } from '@/lib/client/speech'
import { DirectSttListener, LiveKitListener, type TurnUpdate } from '@/lib/client/listening'
import { PRESENCE_LABELS, WorkerPresenceMonitor, type PresenceSnapshot } from '@/lib/client/worker-presence'
import { effectiveMode, modeAvailable } from '@/lib/session-mode'
import { fallbackAudibleToPartner, fallbackNotice, OWNER_FALLBACK_GATES_WORKER } from '@/lib/audio-routing'
import { count, noteTts, recordInterval } from '@/lib/client/metrics'
import { getSupabase } from '@/lib/client/supabase'
import { AuthControls } from './AuthControls'
import { FloatingTip, useFloatingTip } from './ui/FloatingTip'
import { TurnTracker, type PartnerTurn } from '@/lib/turns'
import { partnerIsSpeaking, type OutputState } from '@/lib/output-state'
import { CandidateSet as CandidateSetSchema, INPUT_LANGUAGES, type Candidate, type CandidateSet, type TurnRef } from '@/lib/contracts'
import { randomId, sha256Hex } from '@/lib/hash'
import { clonedVoiceUsable, isLibraryVoice, LIBRARY_VOICES, type ClonedVoiceProfile } from '@/lib/voices'
import { OUTPUT_BCP47 } from '@/lib/languages'

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
}
interface ComposerSource { candidateSetId: string; candidateId: string; turn: TurnRef; original: string; intent: string }
interface HistoryItem { speaker: 'partner' | 'user'; text: string }

const INTENT_ORDER: Record<Candidate['intent'], number> = { continue: 0, clarify: 1, decline: 2, custom: 2 }
const stableOrder = (s: CandidateSet): CandidateSet => ({ ...s, candidates: [...s.candidates].sort((a, b) => INTENT_ORDER[a.intent] - INTENT_ORDER[b.intent]) })
const IDLE_BACKGROUND_END_MS = 3 * 60_000

export function ReVoiceApp() {
  const { prefs, update } = usePrefs()
  useScanning(prefs.scanning, prefs.scanIntervalMs)

  const [tab, setTab] = useState<Tab>('session')
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [online, setOnline] = useState(true)
  const [output, setOutput] = useState<OutputState>({ kind: 'idle' })
  const [composer, setComposer] = useState('')
  const [composerSource, setComposerSource] = useState<ComposerSource | null>(null)
  const [sourceStale, setSourceStale] = useState<string | null>(null)
  const [lastSpoken, setLastSpoken] = useState('')
  const [confirming, setConfirming] = useState<{ text: string; cacheable: boolean; speakNow: boolean } | null>(null)
  const [largeText, setLargeText] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // partner input
  const [turns, setTurns] = useState<PartnerTurn[]>([])
  const [listening, setListening] = useState<string>('off')
  const [session, setSession] = useState<Session | null>(null)
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

  // refs (callbacks from listeners must see current values)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const statusRef = useRef(status)
  statusRef.current = status
  const sessionRef = useRef<Session | null>(null)
  const listenerRef = useRef<LiveKitListener | DirectSttListener | null>(null)
  const trackerRef = useRef(new TurnTracker(`local-${randomId(6)}`))
  const setRef = useRef<{ set: CandidateSet; draftedFrom: string; used: boolean } | null>(null)
  const engagedRef = useRef(false)
  const historyRef = useRef<HistoryItem[]>([])
  const callsPerTurn = useRef(new Map<number, { n: number; finalDone: boolean; lastHash?: string }>())
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

  // ---------------------------------------------------------------- voice resolution
  const region = status?.providers.region ?? 'us'
  const voice = useMemo(() => {
    if (isLibraryVoice(prefs.voiceId)) return { id: prefs.voiceId, label: LIBRARY_VOICES.find((v) => v.id === prefs.voiceId)?.name ?? prefs.voiceId, warning: null as string | null, clone: undefined as ClonedVoiceProfile | undefined }
    const c = clones.find((v) => v.voiceId === prefs.voiceId)
    if (!c) return { id: 'aai-audrey', label: 'Audrey (fallback)', warning: 'Selected voice not registered — using fallback', clone: undefined }
    const u = clonedVoiceUsable(c, region)
    if (!u.ok) {
      const fb = LIBRARY_VOICES.find((v) => v.id === c.fallbackVoiceId)
      return { id: c.fallbackVoiceId, label: `${fb?.name ?? c.fallbackVoiceId} (fallback)`, warning: `“${c.label}” disabled (${u.reason.replace(/_/g, ' ')}) — using your chosen fallback voice`, clone: undefined }
    }
    return { id: c.voiceId, label: `${c.label} (synthetic clone)`, warning: u.remindRenewal ? `Consent for “${c.label}” expires ${new Date(u.expiresAt).toLocaleDateString()} — renew in Voice` : null, clone: c }
  }, [prefs.voiceId, clones, region])
  const voiceRef = useRef(voice)
  voiceRef.current = voice

  const reloadClones = useCallback(async () => setClones(await db.voices.toArray()), [])
  useEffect(() => { reloadClones() }, [reloadClones])

  // ---------------------------------------------------------------- status & connectivity
  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status())
      setNeedsSignIn(false)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedsSignIn(true)
    }
  }, [])
  useEffect(() => {
    refreshStatus()
    const t = setInterval(refreshStatus, 20_000)
    const sb = getSupabase()
    const sub = sb?.auth.onAuthStateChange(() => refreshStatus())
    const on = () => setOnline(navigator.onLine)
    on()
    window.addEventListener('online', on)
    window.addEventListener('offline', on)
    return () => {
      clearInterval(t)
      sub?.data.subscription.unsubscribe()
      window.removeEventListener('online', on)
      window.removeEventListener('offline', on)
    }
  }, [refreshStatus])

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
      approve: async (text, textHash, source, route) => {
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
          },
          v.clone,
        )
        return r.approval
      },
      directStream: (approval, text, signal) => api.speakStream(approval, text, signal),
      room: null,
      player: playerRef.current!,
      cache: {
        get: async (voiceId, language, textHash) => getCachedAudio(voiceId, language, textHash),
        put: async (voiceId, language, textHash, pcm, sampleRate) => putCachedAudio({ voiceId, language, textHash, pcm, sampleRate }, isLibraryVoice(voiceId)),
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
  const requestSuggestions = useCallback(async (turn: PartnerTurn, final: boolean, preferredIntent?: string) => {
    const p = prefsRef.current
    const st = statusRef.current
    if (!p.aiSuggestions || !st?.providers.groq || !navigator.onLine) return
    const c = callsPerTurn.current.get(turn.turnId) ?? { n: 0, finalDone: false }
    if (c.n >= 2) return
    c.n += 1
    if (final) c.finalDone = true
    c.lastHash = turn.hash
    callsPerTurn.current.set(turn.turnId, c)
    suggAbort.current?.abort()
    const ac = new AbortController()
    suggAbort.current = ac
    setSuggLoading(true)
    setSuggError(null)
    const t0 = performance.now()
    const tracker = trackerRef.current
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
      recordInterval('suggestion_request_to_ready', performance.now() - t0)
      if (marks.current.partnerFinal && final) recordInterval('partner_final_to_candidates', performance.now() - marks.current.partnerFinal)
      // Drop if the conversation already moved on materially.
      if (tracker.staleness(parsed.data.turn, turn.text)) return
      const next = stableOrder(parsed.data)
      const cur = setRef.current
      if (cur && engagedRef.current) {
        // Selection stability: never move targets under the user's cursor.
        setPending(next)
        pendingDraftedFrom.current = turn.text
      } else {
        if (cur && !cur.used) count('aiRejected')
        setRef.current = { set: next, draftedFrom: turn.text, used: false }
        setSet(next)
        setPending(null)
        setStale(null)
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      const code = e instanceof ApiError ? e.code : (e as Error).message
      setSuggError(code.startsWith('groq_') || code === 'budget' ? `Suggestions paused (${code.replace(/_/g, ' ')}). Type or use phrases.` : `Suggestions unavailable (${code}). Type or use phrases.`)
    } finally {
      if (suggAbort.current === ac) {
        suggAbort.current = null
        setSuggLoading(false)
      }
    }
  }, [])
  const pendingDraftedFrom = useRef('')

  const scheduleSuggestions = useCallback((turn: PartnerTurn) => {
    const c = callsPerTurn.current.get(turn.turnId)
    if (turn.endOfTurn) {
      if (debounce.current) clearTimeout(debounce.current)
      if (c?.finalDone || c?.lastHash === turn.hash) return // identical to the provisional draft: no extra call
      void requestSuggestions(turn, true)
      return
    }
    // Draft opportunistically from a stable partial (≈1 update/s), at most once per turn before the final.
    if ((c?.n ?? 0) > 0) return
    if (turn.text.trim().split(/\s+/).length < 6) return
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => {
      const latest = trackerRef.current.get(turn.turnId)
      if (latest && !latest.endOfTurn) void requestSuggestions(latest, false)
    }, 900)
  }, [requestSuggestions])

  // ---------------------------------------------------------------- partner turns (revision-aware)
  const onTurn = useCallback(async (t: TurnUpdate) => {
    const tracker = trackerRef.current
    const isNew = !tracker.get(t.turnId)
    const { turn, changed } = await tracker.apply(t)
    if (!changed) return
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

  // Gap fallback: if a message is held and the partner has gone quiet, release it.
  useEffect(() => {
    const t = setInterval(() => {
      if (speech?.isHolding && !partnerIsSpeaking(trackerRef.current.latest(), Date.now())) void speech.gap()
    }, 500)
    return () => clearInterval(t)
  }, [speech])

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
    const source: SpeakSource | undefined = useSource ? { candidateSetId: src.candidateSetId, candidateId: src.candidateId, turn: src.turn, edited: text !== src.original } : undefined
    const latest = trackerRef.current.latest()
    const partnerSpeaking = !!sessionRef.current && partnerIsSpeaking(latest, Date.now())
    heldContext.current = latest ? { ref: trackerRef.current.ref(latest), text: latest.text } : null
    const r = await speech.request(text, { source, partnerSpeaking, cacheable: opts.cacheable, speakNow: opts.speakNow })
    if (r === 'spoken' || r === 'held') {
      count('approvedTurns')
      if (source) {
        count('aiApproved')
        if (source.edited) count('aiEdited')
        if (setRef.current) setRef.current.used = true
      } else count('typed')
      historyRef.current = [...historyRef.current, { speaker: 'user' as const, text: text.slice(0, 1200) }].slice(-6)
      setLastSpoken(text)
      if (text === composer) {
        setComposer('')
        setComposerSource(null)
        setSourceStale(null)
      }
      engagedRef.current = false
      void refreshStatus()
    }
  }, [speech, sourceStale, composer, playCachedOffline, refreshStatus])

  const stop = useCallback(() => {
    marks.current.stopPressed = performance.now()
    speech?.stop()
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    count('stops')
  }, [speech])

  // Global keys: Escape = Stop (always), Ctrl/Cmd+Enter = Speak composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (largeText) setLargeText(false)
        else if (confirming) setConfirming(null)
        else stop()
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        void doSpeak(composer)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stop, doSpeak, composer, largeText, confirming])

  // Partner coaching presence ("composing…", never the draft content).
  const onComposerChange = (v: string) => {
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
    trackerRef.current.bumpGeneration() // invalidates all outstanding candidates/approvals
    callsPerTurn.current.clear()
    setSet(null)
    setPending(null)
    setRef.current = null
  }, [speech])

  const endSession = useCallback(async (reason: 'user' | 'timeout' | 'budget' | 'idle' | 'error' = 'user') => {
    const s = sessionRef.current
    const l = listenerRef.current
    if (!s && !l) return
    speech?.onRoomLost()
    await l?.close().catch(() => undefined)
    if (s?.kind === 'livekit' && s.room) await api.endSession(s.room, reason).catch(() => undefined)
    cleanupSession()
    setListening('off')
    if (reason !== 'user') setNotice(`Listening ended (${reason}). Typing and phrases still work.`)
    void refreshStatus()
  }, [cleanupSession, refreshStatus, speech])

  const listenerEvents = useMemo(() => ({
    onTurn: (t: TurnUpdate) => void onTurn(t),
    onSpeechStarted: () => { marks.current.speechStarted = performance.now() },
    onStatus: (s: { state: string; detail?: string }) => {
      setListening(s.state)
      if (s.state === 'closed' && sessionRef.current) {
        speech?.onRoomLost()
        cleanupSession()
      }
      if (s.state === 'error') setNotice(`Listening error${s.detail ? ` (${s.detail})` : ''}. Typing and phrases still work.`)
    },
    onWorkerStatus: (s: { type: string; playbackAttemptId?: string; reason?: string }) => {
      if (s.type === 'ready' && presenceRef.current) {
        presenceRef.current.workerReady()
        setWorker(presenceRef.current.snapshot())
      }
      speech?.onWorkerStatus(s)
      if (s.type === 'paused' && s.reason?.startsWith('budget')) void endSession('budget')
      if (s.type === 'ended') void endSession(s.reason === 'timeout' ? 'timeout' : 'idle')
      // B5: rejections that trigger the automatic HTTP-TTS fallback are announced by onRouteFallback instead.
      if (s.type === 'rejected' && !FALLBACK_REJECTIONS.has(s.reason ?? '')) setNotice(`The voice worker refused that message (${s.reason ?? 'rejected'}). Nothing was spoken.`)
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

  const startSession = async () => {
    setNotice(null)
    const st = statusRef.current
    const inputLanguages = prefs.inputLanguages.filter((c): c is (typeof INPUT_LANGUAGES)[number] => (INPUT_LANGUAGES as readonly string[]).includes(c))
    try {
      if (st?.providers.livekit) {
        const r = await api.startSession({ mode, voiceId: voice.id, outputLanguage: prefs.outputLanguage, inputLanguages, keyterms: prefs.keyterms, contextPrompt: prefs.contextPrompt, replace: true })
        setSessionTicket(r.ticket) // B4: signed ticket authorizes approve/end on ANY serverless instance
        trackerRef.current = new TurnTracker(r.conversationId, 0)
        callsPerTurn.current.clear()
        // B6: the listener applies the per-mode audio routing policy (partner-link: voice only on the partner's phone).
        const l = new LiveKitListener(listenerEvents, { url: r.url, token: r.token, publishMic: mode === 'tabletop', mode })
        listenerRef.current = l
        const s: Session = { kind: 'livekit', room: r.room, conversationId: r.conversationId, generation: 0, invite: r.invite, mode, startedAt: Date.now(), maxMinutes: r.maxSessionMinutes }
        sessionRef.current = s
        setSession(s)
        // B5: room mode is NOT enabled on connect. Speech stays on direct HTTP TTS until the worker is
        // confirmed present; the monitor also ends the session automatically if no worker ever joins.
        const monitor = new WorkerPresenceMonitor()
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
            if (monitor.state === 'absent') setNotice('The voice worker has not joined. Your approved words will be spoken from this device. Listening needs the worker — the session ends automatically if it does not arrive.')
            else if (monitor.state === 'lost') setNotice('The voice worker disconnected. Speech continues from this device; listening resumes if it reconnects.')
            else if (monitor.state === 'ready' && (prev === 'absent' || prev === 'lost' || prev === 'degraded')) setNotice('The voice worker is connected again. Listening and room speech are back.')
          }
          if (verdict === 'end') {
            void endSession('error').then(() => setNotice('Listening ended: no voice worker was available to transcribe, so the room was closed and unused listening minutes were released. Typing, phrases and speech still work.'))
          }
        }, 1000)
        watchdog.current = setTimeout(() => void endSession('timeout'), r.maxSessionMinutes * 60_000)
      } else if (st?.providers.browserStt) {
        const conv = randomId(10)
        trackerRef.current = new TurnTracker(conv, 0)
        callsPerTurn.current.clear()
        let maxMin = 20
        const l = new DirectSttListener(listenerEvents, async () => {
          const r = await api.sttToken({ sampleRate: 16000, languageCodes: inputLanguages, keyterms: prefs.keyterms, minutes: 20 })
          maxMin = Math.floor(r.maxSessionSeconds / 60)
          return r
        })
        listenerRef.current = l
        const s: Session = { kind: 'direct', conversationId: conv, generation: 0, invite: null, mode: 'tabletop', startedAt: Date.now(), maxMinutes: maxMin }
        sessionRef.current = s
        setSession(s)
        await l.start()
        speech?.setRoom(null)
        setSession({ ...s, maxMinutes: maxMin })
        watchdog.current = setTimeout(() => void endSession('timeout'), maxMin * 60_000)
      } else {
        setNotice('Listening is not configured on this server. Typing, phrases and speech still work.')
      }
    } catch (e) {
      const code = e instanceof ApiError ? e.code : (e as Error).message
      setNotice(`Could not start listening (${code.replace(/_/g, ' ')}). Typing and phrases still work.`)
      await listenerRef.current?.close().catch(() => undefined)
      if (sessionRef.current?.room) await api.endSession(sessionRef.current.room, 'error').catch(() => undefined)
      cleanupSession()
      setListening('off')
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
      if (s?.kind === 'livekit' && s.room) navigator.sendBeacon?.('/api/livekit/end', new Blob([JSON.stringify({ room: s.room, reason: 'idle', ticket: getSessionTicket() ?? undefined })], { type: 'application/json' }))
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
    setComposer(c.text)
    speech?.edit(c.text)
    setComposerSource({ candidateSetId: s.id, candidateId: c.id, turn: s.turn, original: c.text, intent: c.intent })
    setSourceStale(null)
    document.getElementById('composer-input')?.focus()
  }
  const acceptPending = () => {
    if (!pending) return
    if (setRef.current && !setRef.current.used) count('aiRejected')
    setRef.current = { set: pending, draftedFrom: pendingDraftedFrom.current, used: false }
    setSet(pending)
    setPending(null)
    setStale(null)
    engagedRef.current = false
  }
  const regenerate = () => {
    const latest = trackerRef.current.latest()
    if (!latest) return setSuggError('No partner speech yet to draft from.')
    void requestSuggestions(latest, latest.endOfTurn, prefs.preferredIntent)
  }

  // ---------------------------------------------------------------- render
  const latestTurn = turns[turns.length - 1]
  const speaking = output.kind === 'speaking'
  const holding = output.kind === 'approved_pending_gap'
  const cloudVoiceDown = !status?.providers.assemblyai || !online || output.kind === 'error'
  const elapsedMin = session ? Math.floor((Date.now() - session.startedAt) / 60000) : 0
  const inviteUrl = session?.invite ? `${typeof window !== 'undefined' ? window.location.origin : ''}/join#${encodeURIComponent(session.invite)}` : null
  const isGuest = status?.identity.kind === 'guest'
  const listenAvailable = !!(status?.providers.livekit || status?.providers.browserStt) && !isGuest
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
            <AuthControls needsSignIn={needsSignIn} status={status} />
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

            {prefs.aiSuggestions && session && (
              <Suggestions
                set={set}
                pending={pending}
                stale={stale}
                loading={suggLoading}
                error={suggError}
                passport={set ? { turnId: set.turn.turnId, revision: set.turn.revision, final: set.status === 'final' } : null}
                onEngage={() => { engagedRef.current = true }}
                onUse={useCandidate}
                onAcceptPending={acceptPending}
                onFeedback={(c, verdict) => void db.feedback.add({ id: randomId(8), at: Date.now(), intent: c.intent, verdict, edited: false })}
                onRegenerate={regenerate}
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
                        {isGuest && <p className="rv-alert rv-alert-warn text-sm" role="status"><Icon name="user" size={15} /> Listening sessions need an account (they bill live transcription time). Use <strong>Sign in</strong> at the top. Typing, phrases and voices work as a guest.</p>}
                        {status && !isGuest && !listenAvailable && <p className="rv-muted text-sm">Listening is not configured on this server (needs LiveKit, or the trusted-demo direct mode).</p>}
                      </>
                    ) : (
                      <>
                        <p className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="rv-badge rv-badge-brand">State: {listening}</span>
                          <span className="rv-badge">{session.kind === 'livekit' ? 'LiveKit worker' : 'direct (trusted demo)'}</span>
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
                            <label htmlFor="invite-url" className="text-sm font-semibold">Partner link (expires in 30 min)</label>
                            <div className="flex flex-col gap-2 min-[420px]:flex-row">
                              <input id="invite-url" className="rv-input min-w-0 flex-1 text-sm" readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
                              <button className="rv-btn" onClick={() => void navigator.clipboard?.writeText(inviteUrl)}><Icon name="copy" size={15} /> Copy</button>
                            </div>
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
                  <label className="rv-glass grid gap-2 p-4 text-sm font-semibold sm:p-5">
                    <span className="flex items-center gap-2"><Icon name="hand" size={16} /> “Hold My Turn” phrase (spoken exactly as written when you press it)</span>
                    <input className="rv-input font-normal" maxLength={120} value={prefs.holdTurnPhrase} onChange={(e) => update({ holdTurnPhrase: e.target.value || 'I have something to add.' })} />
                  </label>
                </div>
              )}
              {tab === 'bank' && <MessageBank />}
              {tab === 'privacy' && <PrivacyPanel />}
              {tab === 'metrics' && (<div className="grid gap-4"><MetricsPanel status={status} />{status?.identity.kind === 'supabase' && <ReconcilePanel />}</div>)}
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

