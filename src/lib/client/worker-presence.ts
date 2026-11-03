/**
 * B5 — Worker presence detection.
 *
 * Previously the owner's device switched speech into "room mode" the instant it connected to the
 * LiveKit room, before the Python worker had joined. If the agent was not deployed, was cold, or
 * crashed, EVERY Speak during the session failed with `worker_not_present`, with no notice and no
 * timeout — even though server-authorized HTTP TTS (/api/speak) worked fine.
 *
 * This pure, clock-injected state machine decides, at any moment, which route approved speech
 * takes and whether the listening session should be ended automatically:
 *
 *   connecting ──connected──► waiting ──worker ready──► ready ──worker left──► lost
 *                                │                        ▲                     │
 *                                └──join timeout──► absent ┴──worker ready──────┘
 *
 *  - route() is 'room' ONLY in `ready`. In every other state speech uses direct HTTP TTS, so
 *    speaking is never blocked by a missing worker.
 *  - `ready` requires the agent participant to be present AND either a `ready` status from the
 *    worker, or the agent having been present for READY_GRACE_MS (compat with older workers).
 *  - A worker that never joins, or leaves and does not return, makes listening impossible
 *    (it is the worker that transcribes). After ABSENT_END_MS the session is ended automatically
 *    so the room and the STT reservation are released (B3 settlement) instead of idling.
 *  - A failed room delivery (ack timeout / worker_not_present) marks the worker `degraded`: speech
 *    stays direct until the worker proves itself again with a fresh `ready`.
 */
export type WorkerPresenceState = 'connecting' | 'waiting' | 'ready' | 'absent' | 'lost' | 'degraded'
export type SpeechRoute = 'room' | 'direct'

export const WORKER_JOIN_TIMEOUT_MS = 12_000
export const WORKER_READY_GRACE_MS = 4_000
export const WORKER_ABSENT_END_MS = 45_000
export const WORKER_LOST_END_MS = 30_000

export interface WorkerPresenceOptions {
  now?: () => number
  joinTimeoutMs?: number
  readyGraceMs?: number
  absentEndMs?: number
  lostEndMs?: number
}

export interface PresenceSnapshot {
  state: WorkerPresenceState
  route: SpeechRoute
  /** Short machine reason for the current direct route (null when routing through the room). */
  reason: string | null
}

export class WorkerPresenceMonitor {
  private s: WorkerPresenceState = 'connecting'
  private connectedAt: number | null = null
  private agentSince: number | null = null
  private agentPresent = false
  private readyAck = false
  private lostAt: number | null = null
  private degradedReason: string | null = null
  private endRequested = false
  private readonly now: () => number
  private readonly o: Required<Omit<WorkerPresenceOptions, 'now'>>

  constructor(opts: WorkerPresenceOptions = {}) {
    this.now = opts.now ?? Date.now
    this.o = {
      joinTimeoutMs: opts.joinTimeoutMs ?? WORKER_JOIN_TIMEOUT_MS,
      readyGraceMs: opts.readyGraceMs ?? WORKER_READY_GRACE_MS,
      absentEndMs: opts.absentEndMs ?? WORKER_ABSENT_END_MS,
      lostEndMs: opts.lostEndMs ?? WORKER_LOST_END_MS,
    }
  }

  get state() {
    return this.s
  }

  route(): SpeechRoute {
    return this.s === 'ready' ? 'room' : 'direct'
  }

  snapshot(): PresenceSnapshot {
    const route = this.route()
    const reason =
      route === 'room' ? null
        : this.s === 'degraded' ? this.degradedReason ?? 'worker_unresponsive'
          : this.s === 'absent' ? 'worker_absent'
            : this.s === 'lost' ? 'worker_lost'
              : 'worker_not_ready'
    return { state: this.s, route, reason }
  }

  /** The owner's device finished connecting to the room. */
  connected() {
    if (this.connectedAt === null) this.connectedAt = this.now()
    if (this.s === 'connecting') this.s = 'waiting'
    this.evaluate()
  }

  /** An agent participant is (or became) present in the room. */
  agentJoined() {
    if (!this.agentPresent) this.agentSince = this.now()
    this.agentPresent = true
    this.evaluate()
  }

  /** The agent participant left (crash, redeploy, job ended). */
  agentLeft() {
    const wasUsable = this.s === 'ready' || this.s === 'degraded'
    this.agentPresent = false
    this.agentSince = null
    this.readyAck = false
    if (wasUsable || this.s === 'waiting') {
      this.s = this.s === 'waiting' ? 'waiting' : 'lost'
      if (this.s === 'lost') this.lostAt = this.now()
    }
    this.evaluate()
  }

  /** The worker reported `ready` (initial start, or in reply to a hello). Clears degradation. */
  workerReady() {
    this.readyAck = true
    if (!this.agentPresent) {
      // A ready status can only come from a present agent; treat it as presence.
      this.agentPresent = true
      this.agentSince = this.now()
    }
    this.degradedReason = null
    if (this.s === 'degraded') this.s = 'waiting'
    this.evaluate()
  }

  /** A room delivery failed before any audio (ack timeout, worker_not_present). */
  degrade(reason: string) {
    this.readyAck = false
    this.degradedReason = reason
    if (this.s === 'ready' || this.s === 'waiting') this.s = 'degraded'
    if (!this.agentPresent && this.s !== 'absent') {
      this.s = 'lost'
      this.lostAt = this.lostAt ?? this.now()
    }
  }

  /**
   * Periodic check (call ~1/s). Returns 'end' exactly once when the session should be ended
   * automatically because no worker can transcribe; otherwise null.
   */
  tick(): 'end' | null {
    this.evaluate()
    if (this.endRequested) return null
    const now = this.now()
    if (this.s === 'absent' && this.connectedAt !== null && now - this.connectedAt >= this.o.absentEndMs) {
      this.endRequested = true
      return 'end'
    }
    if (this.s === 'lost' && this.lostAt !== null && now - this.lostAt >= this.o.lostEndMs) {
      this.endRequested = true
      return 'end'
    }
    return null
  }

  private evaluate() {
    const now = this.now()
    if (this.s === 'connecting' || this.s === 'degraded') return
    if (this.agentPresent) {
      const graceOk = this.agentSince !== null && now - this.agentSince >= this.o.readyGraceMs
      if (this.readyAck || graceOk) {
        this.s = 'ready'
        this.lostAt = null
        return
      }
      if (this.s === 'absent' || this.s === 'lost') this.s = 'waiting'
    }
    if (this.s === 'waiting' && !this.agentPresent && this.connectedAt !== null && now - this.connectedAt >= this.o.joinTimeoutMs) {
      this.s = 'absent'
    }
  }
}

export const PRESENCE_LABELS: Record<WorkerPresenceState, string> = {
  connecting: 'Connecting…',
  waiting: 'Waiting for the voice worker',
  ready: 'Voice worker connected',
  absent: 'Voice worker did not join',
  lost: 'Voice worker disconnected',
  degraded: 'Voice worker not responding',
}
