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
 *  6. (B5) Room mode is used ONLY while the worker is confirmed present (`route()` === 'room').
 *     Otherwise approved speech goes through server-authorized HTTP TTS. If a room delivery
 *     fails BEFORE any audio (worker absent / no acknowledgement), the controller cancels that
 *     attempt at the worker and speaks the SAME frozen text once via HTTP TTS with a fresh,
 *     route-bound server signature. It never falls back after audio may have been heard
 *     (that stays DeliveryUncertain) and never changes the words.
 *
 * Framework-agnostic and dependency-injected so the invariants are unit-testable in Node.
 */
import type { Approval } from '../contracts'
import { reduceOutput, type OutputEvent, type OutputState } from '../output-state'
import type { SpeechRoute } from './worker-presence'
import { heldApprovalExpired } from '../shortcuts'

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
  /** C #31: the server-signed proof of the candidate set, and the exact partner text it was drafted from. */
  proof?: string
  draftedFrom?: string
  /** C #31: the newest partner turn this device holds at approval time (the server verifies it by hash). */
  current?: { turn: import('../contracts').TurnRef; text: string }
}

export interface SpeakOptions {
  source?: SpeakSource
  partnerSpeaking: boolean
  /** Phrase-board phrase the owner marked as cacheable (library voices only). */
  cacheable?: boolean
}

export interface SpeechDeps {
  sha256(text: string): Promise<string>
  /**
   * Server-signed approval for the exact text. `route` decides the binding: 'room' approvals are bound
   * to the LiveKit room (verified by the worker); 'direct' approvals carry roomName=null (verified by /api/speak).
   */
  approve(text: string, textHash: string, source: SpeakSource | undefined, route: SpeechRoute): Promise<Approval>
  directStream(approval: Approval, text: string, signal: AbortSignal): Promise<{ body: ReadableStream<Uint8Array>; sampleRate: number }>
  /** Present when a LiveKit worker is connected: the worker synthesizes into the room. */
  room?: { speak(approval: Approval, text: string): Promise<void>; stop(attemptId?: string): Promise<void> } | null
  /**
   * B5: live routing decision from the worker-presence monitor. When omitted, the room is used whenever
   * it is set (legacy behaviour). When it returns 'direct', speech uses HTTP TTS even during a session.
   */
  route?(): SpeechRoute
  /** B5: a room delivery failed before audio; the controller is falling back to HTTP TTS. */
  onRouteFallback?(reason: string): void
  /** B5: how long to wait for the worker to acknowledge (status 'speaking' / rejection) a room speak. */
  roomAckTimeoutMs?: number
  player: PlayerLike
  cache?: {
    get(voiceId: string, language: string, textHash: string): Promise<{ pcm: ArrayBuffer; sampleRate: number } | undefined>
    put(voiceId: string, language: string, textHash: string, pcm: ArrayBuffer, sampleRate: number): Promise<void>
  }
  onState(s: OutputState): void
  /**
   * C #26: fires ONCE per utterance, when audio has actually started (room: the worker's `speaking` status; direct: the
   * first audio chunk / cached clip). The caller commits "this was said" (history, composer clear, counters) HERE — not when
   * the request was merely dispatched, held for a gap, or still waiting for the worker (a rejected/held/failed message used
   * to be recorded as spoken and the composer cleared, losing the owner's words).
   */
  onHeard?(h: { attemptId: string; text: string; opts: SpeakOptions }): void
  onMark?(name: 'approval' | 'tts_request' | 'first_audio' | 'done' | 'stop_silenced', at: number, info?: { warm?: boolean; cached?: boolean }): void
  now?(): number
}

/**
 * C #20: statuses that describe ONE utterance. They are applied only when they carry the CURRENT attempt's id. Session-level
 * statuses (`listening` / `paused` / `reconnecting` / `ready` / `ended`) are never speech outcomes — they used to be able to
 * acknowledge, finish or fail whatever utterance happened to be in flight.
 */
export const SPEECH_STATUS_TYPES: ReadonlySet<string> = new Set(['speaking', 'done', 'cancelled', 'uncertain', 'rejected', 'error'])

export const MAX_HOLD_MS = 45_000
export const ROOM_ACK_TIMEOUT_MS = 5_000
/** Worker rejections that mean "this worker cannot serve speech" (not a user/budget decision) → fall back. */
export const FALLBACK_REJECTIONS: ReadonlySet<string> = new Set(['bad_signature', 'worker_not_present', 'worker_unreachable'])

export class SpeechController {
  state: OutputState = { kind: 'idle' }
  private abort: AbortController | null = null
  private held: { approval: Approval; text: string; opts: SpeakOptions; at: number; route: SpeechRoute } | null = null
  private attempt: string | null = null
  private roomAttempt: string | null = null
  private stopped = new Set<string>()
  private lastTtsAt = -Infinity
  private roomAck: ReturnType<typeof setTimeout> | null = null
  private roomPending: { approval: Approval; text: string; opts: SpeakOptions; acked: boolean } | null = null
  /** C #26: the utterance whose audio has not been heard yet (cleared by noteHeard / Stop / failure). */
  private heardPending: { attemptId: string; text: string; opts: SpeakOptions } | null = null
  /** Route actually used by the most recent utterance (diagnostics/UI). */
  lastRoute: SpeechRoute | null = null

  constructor(private d: SpeechDeps) {}

  private now() {
    return this.d.now ? this.d.now() : Date.now()
  }

  /** The room utterance a worker status must name to be applied (C #20); null when none is in flight. */
  get activeAttempt(): string | null {
    return this.roomAttempt
  }

  /** Which transport approved speech would use right now. */
  currentRoute(): SpeechRoute {
    if (!this.d.room) return 'direct'
    return this.d.route ? this.d.route() : 'room'
  }

  private emit(e: OutputEvent) {
    this.state = reduceOutput(this.state, e)
    this.d.onState(this.state)
  }

  /** C #26: audio for the current utterance has started — commit it exactly once. */
  private noteHeard() {
    const h = this.heardPending
    if (!h) return
    this.heardPending = null
    this.d.onHeard?.(h)
  }

  edit(text: string) {
    this.emit({ type: 'edit', text })
  }

  /** User pressed Speak (or Speak Now). Freezes exact text → approval → speech (or hold for a gap). */
  async request(text: string, opts: SpeakOptions & { speakNow?: boolean }): Promise<'spoken' | 'pending' | 'held' | 'rejected' | 'busy' | 'stopped' | 'uncertain' | 'error'> {
    if (this.state.kind === 'speaking') return 'busy'
    const frozen = text // exact displayed text — no trimming or rewriting after approval
    const hash = await this.d.sha256(frozen)
    let approval: Approval
    const route = this.currentRoute() // B5: the approval is bound to the route chosen right now
    try {
      approval = await this.d.approve(frozen, hash, opts.source, route)
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
      this.held = { approval, text: frozen, opts, at: this.now(), route }
      return 'held'
    }
    return this.play(approval, frozen, opts, route)
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
    // D #40: durations only — `approval.exp` is a SERVER timestamp and must never be compared with this device's clock.
    if (heldApprovalExpired(h.approval, h.at, this.now(), MAX_HOLD_MS)) {
      this.emit({ type: 'context_changed', reason: 'hold_expired' })
      return 'expired' as const
    }
    this.emit({ type: kind })
    return this.play(h.approval, h.text, h.opts, h.route)
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

  private async play(approval: Approval, text: string, opts: SpeakOptions, approvedFor: SpeechRoute) {
    const route = this.currentRoute()
    // Room mode: the worker verifies the approval again and publishes audio into the room.
    // B5: only while the worker is confirmed present AND the approval was issued for the room.
    if (route === 'room' && approvedFor === 'room' && this.d.room) {
      const attemptId = approval.playbackAttemptId
      this.attempt = attemptId
      this.heardPending = { attemptId, text, opts }
      this.lastRoute = 'room' // set before 'started' so onState observers see the right route
      this.emit({ type: 'started', attemptId })
      this.d.onMark?.('tts_request', this.now(), { warm: this.now() - this.lastTtsAt < 5 * 60_000 })
      this.roomAttempt = attemptId
      this.roomPending = { approval, text, opts, acked: false }
      try {
        await this.d.room.speak(approval, text)
      } catch (e) {
        // Nothing reached the worker → nothing was heard → safe to deliver via HTTP TTS instead.
        return this.fallbackToDirect((e as Error).message || 'worker_unreachable')
      }
      if (this.roomAttempt === attemptId && this.roomPending && !this.roomPending.acked) {
        this.roomAck = setTimeout(() => {
          this.roomAck = null
          if (this.roomAttempt === attemptId && this.roomPending && !this.roomPending.acked && !this.stopped.has(attemptId)) {
            void this.fallbackToDirect('worker_no_ack')
          }
        }, this.d.roomAckTimeoutMs ?? ROOM_ACK_TIMEOUT_MS)
      }
      return 'pending' as const // C #26: dispatched, NOT yet heard — completion/audio arrives via onWorkerStatus()
    }

    // Direct HTTP TTS. A room-bound approval is not valid at /api/speak (roomName must be null), so a
    // held room approval whose route changed (worker left during the hold) is re-signed for the direct
    // route — same frozen text, nothing has been heard yet.
    if (approvedFor === 'room') {
      const direct = await this.reapproveDirect(text, opts)
      if (!direct) return 'rejected' as const
      approval = direct
    }
    return this.playDirect(approval, text, opts)
  }

  /** Fresh server signature for the SAME exact text, bound to the direct route. */
  private async reapproveDirect(text: string, opts: SpeakOptions): Promise<Approval | null> {
    try {
      const hash = await this.d.sha256(text)
      const a = await this.d.approve(text, hash, opts.source, 'direct')
      if (a.textHash !== hash || a.roomName) {
        this.emit({ type: 'failed', message: 'altered_text' })
        return null
      }
      return a
    } catch (e) {
      this.emit({ type: 'failed', message: (e as Error).message || 'approval_rejected' })
      return null
    }
  }

  /**
   * B5: room delivery failed BEFORE any audio. Cancel the attempt at the worker (so a late worker can
   * never also speak it), then deliver the same frozen text once via HTTP TTS.
   */
  private async fallbackToDirect(reason: string) {
    const pending = this.roomPending
    const attemptId = this.roomAttempt
    this.clearRoomAck()
    this.roomPending = null
    this.roomAttempt = null
    if (!pending || (attemptId && this.stopped.has(attemptId))) return 'stopped' as const
    if (this.state.kind === 'speaking' && this.state.audioStarted) {
      // Audio may have been heard → never re-speak automatically.
      this.emit({ type: 'network_failed', reason })
      return 'uncertain' as const
    }
    if (attemptId) {
      this.stopped.add(attemptId) // late statuses/frames for the room attempt are ignored
      void this.d.room?.stop(attemptId).catch(() => undefined)
    }
    this.d.onRouteFallback?.(reason)
    const direct = await this.reapproveDirect(pending.text, pending.opts)
    if (!direct) return 'rejected' as const
    if (this.state.kind !== 'speaking') return 'stopped' as const // user pressed Stop meanwhile
    return this.playDirect(direct, pending.text, pending.opts)
  }

  private clearRoomAck() {
    if (this.roomAck) clearTimeout(this.roomAck)
    this.roomAck = null
  }

  private async playDirect(approval: Approval, text: string, opts: SpeakOptions) {
    const attemptId = approval.playbackAttemptId
    this.attempt = attemptId
    this.heardPending = { attemptId, text, opts }
    this.lastRoute = 'direct'
    this.emit({ type: 'started', attemptId })
    const warm = this.now() - this.lastTtsAt < 5 * 60_000
    this.d.onMark?.('tts_request', this.now(), { warm })

    // Authorized phrase cache (library voices only; see db.putCachedAudio).
    if (opts.cacheable && this.d.cache) {
      const hit = await this.d.cache.get(approval.voiceId, approval.outputLanguage, approval.textHash).catch(() => undefined)
      if (hit) {
        await this.d.player.unlock().catch(() => undefined)
        this.d.player.begin(attemptId)
        this.d.player.push(attemptId, new Uint8Array(hit.pcm), hit.sampleRate)
        this.emit({ type: 'first_audio' })
        this.noteHeard()
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
          this.noteHeard()
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

  /**
   * Worker status for room-mode playback. Returns true when it was applied to the current utterance.
   * C #20: a speech status is applied ONLY when it carries the current attempt's id; a status without one, for another
   * attempt, or a session-level status never touches the current utterance.
   */
  onWorkerStatus(s: { type: string; playbackAttemptId?: string; reason?: string }): boolean {
    if (!SPEECH_STATUS_TYPES.has(s.type)) return false
    if (!s.playbackAttemptId || !this.roomAttempt || s.playbackAttemptId !== this.roomAttempt) return false
    if (this.stopped.has(this.roomAttempt)) return false
    if (this.roomPending) this.roomPending.acked = true
    this.clearRoomAck()
    if ((s.type === 'rejected' || s.type === 'error') && FALLBACK_REJECTIONS.has(s.reason ?? '') && !(this.state.kind === 'speaking' && this.state.audioStarted)) {
      // The worker cannot serve speech (e.g. mismatched secret). Nothing was heard → HTTP TTS.
      void this.fallbackToDirect(`worker_${s.reason}`)
      return true
    }
    switch (s.type) {
      case 'speaking':
        this.emit({ type: 'first_audio' })
        this.noteHeard()
        this.d.onMark?.('first_audio', this.now())
        break
      case 'done':
        this.noteHeard() // `done` can overtake `speaking` for a very short phrase
        this.roomAttempt = null
        this.roomPending = null
        this.lastTtsAt = this.now()
        this.emit({ type: 'finished' })
        this.d.onMark?.('done', this.now())
        break
      case 'uncertain':
        if (this.state.kind === 'speaking' && !this.state.audioStarted) this.emit({ type: 'first_audio' })
        this.noteHeard() // audio started on the worker: part of it may have been heard — it counts as said, never replayed
        this.roomAttempt = null
        this.roomPending = null
        this.emit({ type: 'network_failed', reason: s.reason ?? 'delivery_uncertain' })
        break
      case 'rejected':
      case 'error':
        this.heardPending = null
        this.roomAttempt = null
        this.roomPending = null
        this.emit({ type: 'failed', message: s.reason ?? s.type })
        break
      case 'cancelled':
        this.heardPending = null
        this.roomAttempt = null
        this.roomPending = null
        break
    }
    return true
  }

  /**
   * B5 hardening: the worker participant LEFT the room while a room utterance was in flight.
   * Previously the controller waited for a `done` that could never arrive (stuck in Speaking, Speak
   * blocked as `busy`) when the worker had already acknowledged. Now:
   *  - nothing heard yet (no `speaking` status) → cancel + same frozen text once via HTTP TTS;
   *  - audio may have been heard → Delivery uncertain (never an automatic replay).
   */
  async onWorkerLeft(): Promise<'none' | 'spoken' | 'uncertain' | 'rejected' | 'stopped' | 'error'> {
    if (!this.roomAttempt || !this.roomPending) return 'none'
    return this.fallbackToDirect('worker_left')
  }

  /** Worker connection dropped mid-utterance → uncertain if audio may have been heard. */
  onRoomLost() {
    this.clearRoomAck()
    if (this.state.kind === 'speaking' && this.roomAttempt) {
      this.roomAttempt = null
      this.roomPending = null
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
    if (this.d.room && this.roomAttempt) void this.d.room.stop(this.roomAttempt).catch(() => undefined)
    else if (this.d.room) void this.d.room.stop(attemptId ?? undefined).catch(() => undefined)
    this.clearRoomAck()
    this.roomAttempt = null
    this.roomPending = null
    this.heardPending = null // stopped before any audio: it was never said, so it is never committed
    this.held = null
    this.emit({ type: 'stop' })
  }

  reset() {
    this.held = null
    this.heardPending = null
    this.emit({ type: 'reset' })
  }

  setRoom(room: SpeechDeps['room']) {
    this.d.room = room
    if (!room) {
      this.clearRoomAck()
      this.roomPending = null
    }
  }

  /** B5: install (or clear) the live routing decision from the worker-presence monitor. */
  setRouteSource(route: SpeechDeps['route'] | undefined) {
    this.d.route = route
  }

  budgetPaused(reason: string) {
    this.emit({ type: 'budget', reason })
  }
}
