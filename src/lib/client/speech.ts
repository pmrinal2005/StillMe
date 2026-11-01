/**
 * SpeechController — the ONLY client path that can produce generated speech.
 *
 * Invariants (tests/speech-controller.test.ts):
 *  1. No text reaches any synthesizer without a server-signed approval for that EXACT text.
 *     Draft text is never sent to TTS ahead of approval (no speculative synthesis).
 *  2. Stop silences local audio immediately, aborts the upstream request (cancels synthesis),
 *     tells the worker to cancel, and drops late frames. Nothing resumes automatically.
 *  3. A failure after audio started → DeliveryUncertain. Replay only by explicit user action,
 *     which always obtains a NEW approval.
 *  4. One utterance at a time.
 *  5. An approval held for a conversational gap is cancelled when context materially changes
 *     or when it has been held too long; the user must approve again.
 *
 * Framework-agnostic and dependency-injected so the invariants are unit-testable in Node.
 */
import type { Approval } from '../contracts'
import { reduceOutput, type OutputEvent, type OutputState } from '../output-state'

export interface PlayerLike {
  unlock(): Promise<void>
  begin(attemptId: string): void
  push(attemptId: string, chunk: Uint8Array, sampleRate: number): void
  drained(): Promise<void>
  stop(): void
}

export interface SpeakSource {
  candidateSetId: string
  candidateId: string
  turn: import('../contracts').TurnRef
  edited: boolean
}

export interface SpeakOptions {
  source?: SpeakSource
  partnerSpeaking: boolean
  /** Phrase-board phrase the owner marked as cacheable (library voices only). */
  cacheable?: boolean
}

export interface SpeechDeps {
  sha256(text: string): Promise<string>
  approve(text: string, textHash: string, source?: SpeakSource): Promise<Approval>
  directStream(approval: Approval, text: string, signal: AbortSignal): Promise<{ body: ReadableStream<Uint8Array>; sampleRate: number }>
  /** Present when a LiveKit worker is connected: the worker synthesizes into the room. */
  room?: { speak(approval: Approval, text: string): Promise<void>; stop(attemptId?: string): Promise<void> } | null
  player: PlayerLike
  cache?: {
    get(voiceId: string, language: string, textHash: string): Promise<{ pcm: ArrayBuffer; sampleRate: number } | undefined>
    put(voiceId: string, language: string, textHash: string, pcm: ArrayBuffer, sampleRate: number): Promise<void>
  }
  onState(s: OutputState): void
  onMark?(name: 'approval' | 'tts_request' | 'first_audio' | 'done' | 'stop_silenced', at: number, info?: { warm?: boolean; cached?: boolean }): void
  now?(): number
}

export const MAX_HOLD_MS = 45_000

export class SpeechController {
  state: OutputState = { kind: 'idle' }
  private abort: AbortController | null = null
  private held: { approval: Approval; text: string; opts: SpeakOptions; at: number } | null = null
  private attempt: string | null = null
  private roomAttempt: string | null = null
  private stopped = new Set<string>()
  private lastTtsAt = -Infinity

  constructor(private d: SpeechDeps) {}

  private now() {
    return this.d.now ? this.d.now() : Date.now()
  }

  private emit(e: OutputEvent) {
    this.state = reduceOutput(this.state, e)
    this.d.onState(this.state)
  }

  edit(text: string) {
    this.emit({ type: 'edit', text })
  }

  /** User pressed Speak (or Speak Now). Freezes exact text → approval → speech (or hold for a gap). */
  async request(text: string, opts: SpeakOptions & { speakNow?: boolean }): Promise<'spoken' | 'held' | 'rejected' | 'busy' | 'stopped' | 'uncertain' | 'error'> {
    if (this.state.kind === 'speaking') return 'busy'
    const frozen = text // exact displayed text — no trimming or rewriting after approval
    const hash = await this.d.sha256(frozen)
    let approval: Approval
    try {
      approval = await this.d.approve(frozen, hash, opts.source)
    } catch (e) {
      this.emit({ type: 'failed', message: (e as Error).message || 'approval_rejected' })
      return 'rejected'
    }
    if (approval.textHash !== hash) {
      // Defence in depth: server must have signed exactly what is displayed.
      this.emit({ type: 'failed', message: 'altered_text' })
      return 'rejected'
    }
    this.d.onMark?.('approval', this.now())
    const hold = opts.partnerSpeaking && !opts.speakNow
    this.emit({ type: 'approved', text: frozen, approvalId: approval.approvalId, partnerSpeaking: hold, now: this.now() })
    if (hold) {
      this.held = { approval, text: frozen, opts, at: this.now() }
      return 'held'
    }
    return this.play(approval, frozen, opts)
  }

  get isHolding() {
    return !!this.held && this.state.kind === 'approved_pending_gap'
  }

  /** A conversational gap was detected (end of partner turn). Speaks a held approval. */
  async gap() {
    return this.releaseHeld('gap')
  }

  /** Deliberate user override: speak the held message now. */
  async speakNow() {
    return this.releaseHeld('speak_now')
  }

  private async releaseHeld(kind: 'gap' | 'speak_now') {
    const h = this.held
    if (!h || this.state.kind !== 'approved_pending_gap') return 'none' as const
    this.held = null
    if (this.now() - h.at > MAX_HOLD_MS || this.now() > h.approval.exp - 2_000) {
      this.emit({ type: 'context_changed', reason: 'hold_expired' })
      return 'expired' as const
    }
    this.emit({ type: kind })
    return this.play(h.approval, h.text, h.opts)
  }

  /** Partner context materially changed while a message was held → renewed approval required. */
  contextChanged(reason: string) {
    if (this.held) {
      this.held = null
      this.emit({ type: 'context_changed', reason })
      return true
    }
    return false
  }

  private async play(approval: Approval, text: string, opts: SpeakOptions) {
    const attemptId = approval.playbackAttemptId
    this.attempt = attemptId
    this.emit({ type: 'started', attemptId })
    const warm = this.now() - this.lastTtsAt < 5 * 60_000
    this.d.onMark?.('tts_request', this.now(), { warm })

    // Room mode: the worker verifies the approval again and publishes audio into the room.
    if (this.d.room) {
      this.roomAttempt = attemptId
      try {
        await this.d.room.speak(approval, text)
        return 'spoken' as const // completion arrives via onWorkerStatus()
      } catch (e) {
        this.roomAttempt = null
        this.emit({ type: 'network_failed', reason: (e as Error).message || 'worker_unreachable' })
        return 'error' as const
      }
    }

    // Authorized phrase cache (library voices only; see db.putCachedAudio).
    if (opts.cacheable && this.d.cache) {
      const hit = await this.d.cache.get(approval.voiceId, approval.outputLanguage, approval.textHash).catch(() => undefined)
      if (hit) {
        await this.d.player.unlock().catch(() => undefined)
        this.d.player.begin(attemptId)
        this.d.player.push(attemptId, new Uint8Array(hit.pcm), hit.sampleRate)
        this.emit({ type: 'first_audio' })
        this.d.onMark?.('first_audio', this.now(), { warm: true, cached: true })
        await this.d.player.drained()
        if (this.stopped.has(attemptId)) return 'stopped' as const
        this.emit({ type: 'finished' })
        this.d.onMark?.('done', this.now())
        return 'spoken' as const
      }
    }

    const ac = new AbortController()
    this.abort = ac
    let audioStarted = false
    const chunks: Uint8Array[] = []
    try {
      await this.d.player.unlock().catch(() => undefined)
      this.d.player.begin(attemptId)
      const { body, sampleRate } = await this.d.directStream(approval, text, ac.signal)
      const reader = body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (this.stopped.has(attemptId)) {
          reader.cancel().catch(() => undefined)
          return 'stopped' as const
        }
        if (done) break
        if (!value?.length) continue
        if (!audioStarted) {
          audioStarted = true
          this.emit({ type: 'first_audio' })
          this.d.onMark?.('first_audio', this.now(), { warm })
        }
        this.d.player.push(attemptId, value, sampleRate)
        if (opts.cacheable) chunks.push(value)
      }
      this.lastTtsAt = this.now()
      await this.d.player.drained()
      if (this.stopped.has(attemptId)) return 'stopped' as const
      this.emit({ type: 'finished' })
      this.d.onMark?.('done', this.now())
      if (opts.cacheable && this.d.cache && chunks.length) {
        const total = chunks.reduce((n, c) => n + c.length, 0)
        const pcm = new Uint8Array(total)
        let o = 0
        for (const c of chunks) {
          pcm.set(c, o)
          o += c.length
        }
        void this.d.cache.put(approval.voiceId, approval.outputLanguage, approval.textHash, pcm.buffer, sampleRate).catch(() => undefined)
      }
      return 'spoken' as const
    } catch (e) {
      if (this.stopped.has(attemptId) || ac.signal.aborted) return 'stopped' as const
      const err = e as Error & { status?: number; code?: string }
      if (err.status === 429 && err.code !== 'rate_limited') {
        this.emit({ type: 'budget', reason: err.code ?? 'budget' })
        return 'error' as const
      }
      // Track whether any audio was heard: decides Error vs DeliveryUncertain. Never auto-retry.
      if (this.state.kind === 'speaking' && !this.state.audioStarted && audioStarted) this.emit({ type: 'first_audio' })
      this.emit({ type: 'network_failed', reason: err.code || err.message || 'network_error' })
      return audioStarted ? ('uncertain' as const) : ('error' as const)
    } finally {
      if (this.abort === ac) this.abort = null
    }
  }

  /** Worker status for room-mode playback. Late statuses for other attempts are ignored. */
  onWorkerStatus(s: { type: string; playbackAttemptId?: string; reason?: string }) {
    if (!this.roomAttempt || (s.playbackAttemptId && s.playbackAttemptId !== this.roomAttempt)) return
    if (this.stopped.has(this.roomAttempt)) return
    switch (s.type) {
      case 'speaking':
        this.emit({ type: 'first_audio' })
        this.d.onMark?.('first_audio', this.now())
        break
      case 'done':
        this.roomAttempt = null
        this.lastTtsAt = this.now()
        this.emit({ type: 'finished' })
        this.d.onMark?.('done', this.now())
        break
      case 'uncertain':
        if (this.state.kind === 'speaking' && !this.state.audioStarted) this.emit({ type: 'first_audio' })
        this.roomAttempt = null
        this.emit({ type: 'network_failed', reason: s.reason ?? 'delivery_uncertain' })
        break
      case 'rejected':
      case 'error':
        this.roomAttempt = null
        this.emit({ type: 'failed', message: s.reason ?? s.type })
        break
      case 'cancelled':
        this.roomAttempt = null
        break
    }
  }

  /** Worker connection dropped mid-utterance → uncertain if audio may have been heard. */
  onRoomLost() {
    if (this.state.kind === 'speaking' && this.roomAttempt) {
      this.roomAttempt = null
      this.emit({ type: 'network_failed', reason: 'connection_lost' })
    }
  }

  /** Immediate Stop: local silence first, then cancel upstream. Never resumes. */
  stop() {
    const attemptId = this.attempt
    if (attemptId) this.stopped.add(attemptId)
    this.d.player.stop()
    this.d.onMark?.('stop_silenced', this.now())
    this.abort?.abort()
    this.abort = null
    if (this.d.room) void this.d.room.stop(this.roomAttempt ?? attemptId ?? undefined).catch(() => undefined)
    this.roomAttempt = null
    this.held = null
    this.emit({ type: 'stop' })
  }

  reset() {
    this.held = null
    this.emit({ type: 'reset' })
  }

  setRoom(room: SpeechDeps['room']) {
    this.d.room = room
  }

  budgetPaused(reason: string) {
    this.emit({ type: 'budget', reason })
  }
}
