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
import { api, ApiError, type StatusResponse } from '@/lib/client/api'
import { db, getCachedAudio, putCachedAudio } from '@/lib/client/db'
import { PcmStreamPlayer } from '@/lib/client/pcm-player'
import { SpeechController, type SpeakSource } from '@/lib/client/speech'
import { DirectSttListener, LiveKitListener, type TurnUpdate } from '@/lib/client/listening'
import { count, noteTts, recordInterval } from '@/lib/client/metrics'
import { getSupabase, signInWithOAuth } from '@/lib/client/supabase'
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
  const [mode, setMode] = useState<Mode>('tabletop')

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
      approve: async (text, textHash, source) => {
        const s = sessionRef.current
        const p = prefsRef.current
        const v = voiceRef.current
        const r = await api.approve(
          {
            text,
            textHash,
            conversationId: s?.conversationId ?? trackerRef.current.conversationId,
            roomName: s?.kind === 'livekit' ? s.room : undefined,
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
        else if (l instanceof LiveKitListener && sessionRef.current?.mode === 'tabletop') void l.gateMic(gated)
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
    listenerRef.current = null
    sessionRef.current = null
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
      speech?.onWorkerStatus(s)
      if (s.type === 'paused' && s.reason?.startsWith('budget')) void endSession('budget')
      if (s.type === 'ended') void endSession(s.reason === 'timeout' ? 'timeout' : 'idle')
      if (s.type === 'rejected') setNotice(`The voice worker refused that message (${s.reason ?? 'rejected'}). Nothing was spoken.`)
    },
    onPartnerPresence: (p: boolean) => setPartnerPresent(p),
  }), [onTurn, speech, cleanupSession, endSession])

  const startSession = async () => {
    setNotice(null)
    const st = statusRef.current
    const inputLanguages = prefs.inputLanguages.filter((c): c is (typeof INPUT_LANGUAGES)[number] => (INPUT_LANGUAGES as readonly string[]).includes(c))
    try {
      if (st?.providers.livekit) {
        const r = await api.startSession({ mode, voiceId: voice.id, outputLanguage: prefs.outputLanguage, inputLanguages, keyterms: prefs.keyterms, contextPrompt: prefs.contextPrompt, replace: true })
        trackerRef.current = new TurnTracker(r.conversationId, 0)
        callsPerTurn.current.clear()
        const l = new LiveKitListener(listenerEvents, { url: r.url, token: r.token, publishMic: mode === 'tabletop', playPartnerAudio: mode === 'remote' })
        listenerRef.current = l
        const s: Session = { kind: 'livekit', room: r.room, conversationId: r.conversationId, generation: 0, invite: r.invite, mode, startedAt: Date.now(), maxMinutes: r.maxSessionMinutes }
        sessionRef.current = s
        setSession(s)
        await l.start()
        speech?.setRoom(l)
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
      if (s?.kind === 'livekit' && s.room) navigator.sendBeacon?.('/api/livekit/end', new Blob([JSON.stringify({ room: s.room, reason: 'idle' })], { type: 'application/json' }))
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

  return (
    <main id="revoice-app" className="mx-auto grid max-w-6xl gap-4 p-3 pb-40 sm:p-6 sm:pb-40">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-extrabold">ReVOICE <span className="rv-muted text-base font-normal">— you approve every word</span></h1>
        <AuthControls needsSignIn={needsSignIn} status={status} />
      </header>

      <StatusBar status={status} online={online} output={output} listening={listening} voiceLabel={voice.label} voiceWarning={voice.warning} />

      {notice && <p role="alert" className="rv-panel p-3" style={{ borderColor: 'var(--warn)' }}>{notice} <button className="rv-btn ml-2 text-sm" onClick={() => setNotice(null)}>Dismiss</button></p>}

      {/* ------------------------------------------------ live captions */}
      {session && (
        <section id="live-captions" aria-labelledby="captions-h" className="rv-panel p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 id="captions-h" className="text-lg font-bold">Partner captions</h2>
            <span className="rv-muted text-sm">{partnerPresent ? 'Partner connected · ' : ''}{session.mode} · {elapsedMin}/{session.maxMinutes} min</span>
          </div>
          <ol className="grid gap-1" aria-label="Recent partner turns">
            {turns.map((t) => (
              <li key={t.turnId} className={t.endOfTurn ? 'text-lg' : 'rv-muted text-lg italic'}>
                {t.text || '…'} {!t.endOfTurn && <span className="sr-only">(still speaking)</span>}
              </li>
            ))}
            {turns.length === 0 && <li className="rv-muted">Waiting for your partner to speak…</li>}
          </ol>
          <p className="sr-only" aria-live="polite">{latestTurn?.endOfTurn ? `Partner said: ${latestTurn.text}` : ''}</p>
        </section>
      )}

      {/* ------------------------------------------------ suggestions */}
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

      {/* ------------------------------------------------ composer */}
      <section id="composer" aria-labelledby="composer-h" className="rv-panel grid gap-3 p-4">
        <h2 id="composer-h" className="text-lg font-bold">Your message</h2>
        {composerSource && (
          <p className="rv-badge self-start" style={sourceStale ? { borderColor: 'var(--warn)' } : {}}>
            {sourceStale ? `⚠ Context changed since this suggestion (${sourceStale.replace(/_/g, ' ')}). If you speak it, it is sent as your own words.` : `From suggestion (${composerSource.intent}) · answers turn #${composerSource.turn.turnId}${composer !== composerSource.original ? ' · edited' : ''}`}
          </p>
        )}
        <label htmlFor="composer-input" className="sr-only">Message to speak</label>
        <textarea
          id="composer-input"
          className="rv-input min-h-32 text-2xl leading-snug"
          value={composer}
          maxLength={1000}
          placeholder="Type what you want to say…"
          onChange={(e) => onComposerChange(e.target.value)}
          aria-describedby="composer-help"
        />
        <p id="composer-help" className="rv-muted text-sm">Speak says exactly this text. Ctrl+Enter = Speak · Esc = Stop.</p>
        <div className="flex flex-wrap gap-2">
          <button data-scan className="rv-btn rv-btn-primary flex-1 text-xl" disabled={!composer.trim() || speaking} onClick={() => void doSpeak(composer)}>🔊 Speak</button>
          <button data-scan className="rv-btn" disabled={!composer.trim() && !lastSpoken} onClick={() => setLargeText(true)}>Show large text</button>
          <button data-scan className="rv-btn" disabled={speaking} onClick={holdMyTurn} title="Speaks your Hold My Turn phrase now">✋ “{prefs.holdTurnPhrase}”</button>
          <button className="rv-btn" disabled={!composer} onClick={() => { setComposer(''); setComposerSource(null); setSourceStale(null); speech?.edit('') }}>Clear</button>
          {prefs.deviceVoiceFallback && cloudVoiceDown && (
            <button data-scan className="rv-btn" disabled={!composer.trim()} onClick={() => speakDevice(composer)} title="Uses this device's built-in voice, not your ReVOICE voice">Speak with device voice</button>
          )}
        </div>

        {confirming && (
          <div role="dialog" aria-modal="false" aria-labelledby="confirm-h" className="rv-panel grid gap-2 p-3" style={{ borderColor: 'var(--accent)' }}>
            <h3 id="confirm-h" className="font-bold">Speak exactly this?</h3>
            <p className="text-xl">“{confirming.text}”</p>
            <div className="flex gap-2">
              <button data-scan className="rv-btn rv-btn-primary flex-1" autoFocus onClick={() => void doSpeak(confirming.text, { cacheable: confirming.cacheable, speakNow: confirming.speakNow, confirmed: true })}>Yes, speak</button>
              <button data-scan className="rv-btn flex-1" onClick={() => setConfirming(null)}>No</button>
            </div>
          </div>
        )}
        {holding && (
          <div role="status" className="rv-panel flex flex-wrap items-center gap-2 p-3" style={{ borderColor: 'var(--accent)' }}>
            <span className="flex-1">Approved — waiting for your partner to pause: “{output.text}”</span>
            <button data-scan className="rv-btn rv-btn-primary" onClick={() => void speech?.speakNow()}>Speak now</button>
          </div>
        )}
        {output.kind === 'delivery_uncertain' && (
          <div role="alert" className="rv-panel grid gap-2 p-3" style={{ borderColor: 'var(--warn)' }}>
            <p><strong>Delivery uncertain.</strong> The connection failed while speaking — your partner may have heard part or none of: “{output.text}”. It will not be replayed automatically.</p>
            <div className="flex gap-2">
              <button data-scan className="rv-btn" onClick={() => { const t = output.text; speech?.reset(); void doSpeak(t) }}>Replay (asks for new approval)</button>
              <button className="rv-btn" onClick={() => speech?.reset()}>Dismiss</button>
            </div>
          </div>
        )}
        {output.kind === 'interrupted' && <p role="status" className="rv-muted">Stopped. Interrupted messages never resume on their own.</p>}
        {output.kind === 'error' && <p role="alert" style={{ color: 'var(--warn)' }}>Could not speak ({output.message.replace(/_/g, ' ')}). Nothing was replayed automatically.</p>}
        {output.kind === 'paused_for_budget' && <p role="alert" style={{ color: 'var(--warn)' }}>Voice paused by the daily budget ({output.reason.replace(/_/g, ' ')}). Use the device voice, large text or your message bank.</p>}
      </section>

      <PhraseBoards onPick={(text, o) => { setComposer(text); setComposerSource(null); setSourceStale(null); speech?.edit(text); if (o.cacheable) void doSpeak(text, { cacheable: true }) }} cacheAllowed={isLibraryVoice(voice.id)} />

      {/* ------------------------------------------------ secondary panels */}
      <nav aria-label="Panels" className="flex flex-wrap gap-2" role="tablist">
        {([['session', 'Listening'], ['voice', 'Voice'], ['settings', 'Settings'], ['bank', 'Message bank'], ['privacy', 'Privacy'], ['metrics', 'Measurements']] as [Tab, string][]).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} aria-controls={`panel-${k}`} className="rv-btn" aria-pressed={tab === k} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>
      <div id={`panel-${tab}`} role="tabpanel">
        {tab === 'session' && (
          <section id="session-panel" aria-labelledby="session-h" className="rv-panel grid gap-3 p-4">
            <h2 id="session-h" className="text-lg font-bold">Listening session</h2>
            <p className="rv-muted text-sm">Listening is always explicit, bounded ({status?.budget.limits?.assembly.interactiveSessionMinutes ?? 20} min max), and billed by connected time — pausing disconnects transcription. Your partner must know they are being transcribed.</p>
            {!session ? (
              <>
                <fieldset className="grid gap-2 sm:grid-cols-3">
                  <legend className="sr-only">Conversation mode</legend>
                  {([['tabletop', 'Tabletop', 'This device hears your partner and plays your voice.'], ['partner-link', 'Partner link', 'Partner joins on their phone with a link; cleaner audio separation.'], ['remote', 'Remote call', 'Browser call with a remote partner.']] as [Mode, string, string][]).map(([k, l, d]) => (
                    <label key={k} className="rv-btn flex-col items-start text-left">
                      <span><input type="radio" name="mode" checked={mode === k} onChange={() => setMode(k)} disabled={!status?.providers.livekit && k !== 'tabletop'} /> <strong>{l}</strong></span>
                      <span className="rv-muted text-xs font-normal">{d}</span>
                    </label>
                  ))}
                </fieldset>
                <button data-scan className="rv-btn rv-btn-primary" onClick={startSession} disabled={!online || (!status?.providers.livekit && !status?.providers.browserStt)}>
                  🎧 Start listening
                </button>
                {status && !status.providers.livekit && !status.providers.browserStt && <p className="rv-muted text-sm">Listening is not configured on this server (needs LiveKit, or the trusted-demo direct mode).</p>}
              </>
            ) : (
              <>
                <p>State: <strong>{listening}</strong> · {session.kind === 'livekit' ? 'LiveKit worker' : 'direct (trusted demo)'} · ends automatically after {session.maxMinutes} min</p>
                {inviteUrl && (
                  <div className="grid gap-1">
                    <label htmlFor="invite-url" className="text-sm font-semibold">Partner link (expires in 30 min)</label>
                    <div className="flex gap-2">
                      <input id="invite-url" className="rv-input flex-1 text-sm" readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
                      <button className="rv-btn" onClick={() => void navigator.clipboard?.writeText(inviteUrl)}>Copy</button>
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button data-scan className="rv-btn" onClick={togglePause}>{listening === 'paused' ? '▶ Resume listening' : session.kind === 'direct' ? '⏸ Pause (disconnects)' : '⏸ Pause listening'}</button>
                  <button data-scan className="rv-btn rv-btn-danger" onClick={() => void endSession('user')}>End session</button>
                </div>
              </>
            )}
          </section>
        )}
        {tab === 'voice' && <VoiceWardrobe voiceId={prefs.voiceId} outputLanguage={prefs.outputLanguage} region={region} onSelect={(id) => update({ voiceId: id })} onVoicesChanged={reloadClones} />}
        {tab === 'settings' && (
          <div className="grid gap-3">
            <SettingsPanel prefs={prefs} update={update} />
            <label className="rv-panel grid gap-1 p-4 text-sm">“Hold My Turn” phrase (spoken exactly as written when you press it)
              <input className="rv-input" maxLength={120} value={prefs.holdTurnPhrase} onChange={(e) => update({ holdTurnPhrase: e.target.value || 'I have something to add.' })} />
            </label>
          </div>
        )}
        {tab === 'bank' && <MessageBank />}
        {tab === 'privacy' && <PrivacyPanel />}
        {tab === 'metrics' && <MetricsPanel status={status} />}
      </div>

      <footer className="rv-muted text-xs">
        ReVOICE is an assistive-communication prototype, not a medical device. Do not use with real health information. AI suggestions are drafts; nothing is spoken without your approval of the exact words.
      </footer>

      {/* ------------------------------------------------ always-visible Stop */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex justify-center gap-2 p-3" style={{ background: 'linear-gradient(transparent, var(--bg) 35%)' }}>
        <button id="stop-button" data-scan className="rv-btn rv-btn-danger w-full max-w-xl text-2xl" style={{ minHeight: 'calc(var(--target) * 1.4)' }} onClick={stop} aria-label="Stop speaking now (Escape)">
          ■ STOP {speaking ? '— speaking' : holding ? '— cancel held message' : ''}
        </button>
      </div>

      {largeText && (
        <div role="dialog" aria-modal="true" aria-label="Large text for your partner" className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 p-6" style={{ background: 'var(--bg)' }} onClick={() => setLargeText(false)}>
          <p className="max-w-5xl text-center font-bold leading-tight" style={{ fontSize: 'clamp(2rem, 7vw, 6rem)' }}>{composer.trim() || lastSpoken}</p>
          <button className="rv-btn" autoFocus onClick={() => setLargeText(false)}>Close (Esc)</button>
        </div>
      )}
    </main>
  )
}

function AuthControls({ needsSignIn, status }: { needsSignIn: boolean; status: StatusResponse | null }) {
  const sb = getSupabase()
  if (!sb) return null
  if (needsSignIn) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rv-muted">Sign in for voice & suggestions (typing and phrases work without it):</span>
        <button className="rv-btn" onClick={() => void signInWithOAuth('github')}>GitHub</button>
        <button className="rv-btn" onClick={() => void signInWithOAuth('google')}>Google</button>
      </div>
    )
  }
  return status?.identity.kind === 'supabase' ? <button className="rv-btn text-sm" onClick={() => void sb.auth.signOut()}>Sign out</button> : null
}
