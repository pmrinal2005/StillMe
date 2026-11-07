/**
 * AutoTurnController — the orchestration of opt-in automatic turn-taking, with every side effect injected so the whole
 * flow is unit-tested with a fake clock (tests/auto-turn.test.ts).
 *
 *   partner final turn ─► silence (SilenceTurnDetector, 1.5–3.0 s) ─► guards ─► final Groq draft ─► pickCandidate
 *        ─► visible VETO COUNTDOWN (cancellable) ─► guards again ─► speak() = server-signed approval ─► TTS
 *
 * A pause is never consent on its own: the owner switched the feature on (standing authorization), every guard passes twice,
 * only an unedited, non-committal, risk-"none" AI draft qualifies, the owner can cancel for the whole veto window, and the
 * SERVER re-checks all of it before it signs (src/lib/auto-approval.ts).
 *
 * The controller never talks to the network or the DOM itself; the host (ReVoiceApp) supplies `ensureDraft` and `speak`.
 */
import type { Candidate, CandidateSet } from '../contracts'
import {
  AUTO_VIEW_OFF, AutoTurnLedger, BLOCK_INFO, SilenceTurnDetector, TURN_TAKING, clampMaxConsecutive, clampSilenceMs, clampVetoMs, evaluateAutoGuards,
  pickCandidate, sameAutoView, type AutoApprovalMeta, type AutoBlockReason, type AutoIntent, type AutoView, type GuardVerdict, type SilenceFire, type TurnSignal,
} from '../turn-taking'

export interface AutoConfig {
  enabled: boolean
  silenceMs: number
  vetoMs: number
  /** "Ask me first": show the proposal and wait for a tap instead of speaking when the countdown ends. */
  askFirst: boolean
  maxConsecutive: number
  prefer: AutoIntent
}

export interface AutoContext {
  sessionActive: boolean
  listening: string
  online: boolean
  outputKind: string
  composerText: string
  ownerEngaged: boolean
  suggestionsAvailable: boolean
  lastSpoken?: string
}

export type AutoSpeakResult = 'started' | 'rejected'

export interface AutoTurnDeps {
  now?(): number
  config(): AutoConfig
  context(): AutoContext
  /** Resolve a FINAL candidate set for this exact partner turn (the host drafts it if needed). `null` = none available. */
  ensureDraft(turn: { turnId: number; hash: string; text: string }, signal: { readonly cancelled: boolean }): Promise<CandidateSet | null>
  /** Brake reason if the set no longer matches the conversation, else null. */
  staleness(set: CandidateSet): string | null
  /** Ask the server for an approval of EXACTLY this candidate's text and speak it. `auto` is absent when the owner tapped. */
  speak(set: CandidateSet, cand: Candidate, auto: AutoApprovalMeta | undefined): Promise<AutoSpeakResult>
  onView(v: AutoView): void
  onEvent?(e: { type: 'fired' | 'blocked' | 'cancelled' | 'spoken' | 'tapped'; reason?: AutoBlockReason }): void
}

type Phase = 'idle' | 'drafting' | 'countdown' | 'speaking'
interface Countdown {
  set: CandidateSet
  cand: Candidate
  startedAt: number
  vetoMs: number
  ask: boolean
  expiresAt: number
  silenceMs: number
}

const BLOCK_SHOW_MS = 6_000
const BUSY_OUTPUT = new Set(['speaking', 'approved_pending_gap', 'delivery_uncertain', 'paused_for_budget'])

export class AutoTurnController {
  private det = new SilenceTurnDetector()
  private ledger = new AutoTurnLedger()
  private phase: Phase = 'idle'
  private run = 0
  private cd: Countdown | null = null
  private blocked: { reason: AutoBlockReason; until: number } | null = null
  private last: AutoView = AUTO_VIEW_OFF
  private wasEnabled = false

  constructor(private d: AutoTurnDeps) {}

  private now() {
    return this.d.now ? this.d.now() : Date.now()
  }

  // ---------------------------------------------------------------- inputs from the host
  turnUpdate(t: TurnSignal) {
    this.det.turnUpdate(t, this.now())
  }
  voice(active: boolean) {
    this.det.voice(active, this.now())
  }
  speechStarted() {
    this.det.speechStarted(this.now())
  }
  setSuppressed(on: boolean) {
    this.det.setSuppressed(on, this.now())
  }
  /** The owner typed / chose / spoke something themself: the automatic streak ends. */
  manualAction() {
    this.ledger.manualAction()
  }
  /** The owner started writing: any pending automatic reply is withdrawn. */
  ownerTyping() {
    if (this.phase === 'drafting' || this.phase === 'countdown') this.cancel('owner_typing')
  }
  /** Session ended / started: forget everything about the previous conversation. */
  reset() {
    this.run++
    this.phase = 'idle'
    this.cd = null
    this.blocked = null
    this.det.reset()
    this.ledger.reset()
    this.emit(AUTO_VIEW_OFF)
  }

  /** The owner pressed Cancel / Stop / Esc. Returns true if something was actually withdrawn. */
  cancel(reason: AutoBlockReason = 'owner_cancelled'): boolean {
    if (this.phase === 'drafting') {
      this.run++ // the pending draft result is discarded
      this.phase = 'idle'
      this.d.onEvent?.({ type: 'cancelled', reason })
      this.block(reason, false)
      return true
    }
    if (this.phase === 'countdown') {
      this.cancelCountdown(reason)
      return true
    }
    return false
  }

  /** "Say it now": the owner explicitly taps the proposal. This is an ordinary manual approval (no `auto` flag). */
  async confirmNow(): Promise<boolean> {
    if (this.phase !== 'countdown' || !this.cd) return false
    const cd = this.cd
    if (this.d.staleness(cd.set)) {
      this.cancelCountdown('conversation_changed')
      return false
    }
    this.cd = null
    this.phase = 'speaking'
    this.ledger.manualAction()
    this.d.onEvent?.({ type: 'tapped' })
    this.emit({ phase: 'blocked', progress: 1, message: 'Saying it now…' })
    let r: AutoSpeakResult = 'rejected'
    try {
      r = await this.d.speak(cd.set, cd.cand, undefined)
    } catch {}
    this.phase = 'idle'
    if (r === 'rejected') this.block('rejected')
    return r === 'started'
  }

  // ---------------------------------------------------------------- the clock
  /** Call ~6–10×/s. Cheap when idle. */
  tick() {
    const now = this.now()
    const cfg = this.d.config()
    this.det.setSilenceMs(cfg.silenceMs)
    if (cfg.enabled && !this.wasEnabled) this.det.consumeCurrent() // switched ON: never answer words spoken before that
    this.wasEnabled = cfg.enabled
    if (!cfg.enabled) {
      if (this.phase === 'countdown' || this.phase === 'drafting') {
        this.run++
        this.cd = null
        this.phase = 'idle'
      }
      this.blocked = null
      return this.emit(AUTO_VIEW_OFF)
    }
    if (this.blocked && now >= this.blocked.until) this.blocked = null
    if (this.phase === 'idle') {
      const fire = this.det.tick(now)
      if (fire) {
        void this.onFire(fire)
        return this.emit(this.draftingView())
      }
      return this.emit(this.idleView(now, cfg))
    }
    if (this.phase === 'drafting') return this.emit(this.draftingView())
    if (this.phase === 'countdown') return this.checkCountdown(now, cfg)
  }

  // ---------------------------------------------------------------- flow
  private guards(now: number, turn: TurnSignal | null): GuardVerdict {
    const cfg = this.d.config()
    const c = this.d.context()
    return evaluateAutoGuards({
      enabled: cfg.enabled,
      sessionActive: c.sessionActive,
      listening: c.listening,
      online: c.online,
      outputKind: c.outputKind,
      partnerActive: this.det.partnerActive(now),
      composerText: c.composerText,
      ownerEngaged: c.ownerEngaged,
      turn: turn ? { text: turn.text, endOfTurn: turn.endOfTurn } : null,
      suggestionsAvailable: c.suggestionsAvailable,
      lastSpoken: c.lastSpoken,
      now,
      ledger: this.ledger.snapshot(now),
      maxConsecutive: cfg.maxConsecutive,
    })
  }

  private async onFire(fire: SilenceFire) {
    const now = this.now()
    const t = this.det.latest
    if (!t || t.turnId !== fire.turnId) return
    const g = this.guards(now, t)
    if (!g.ok) return this.block(g.reason)
    this.d.onEvent?.({ type: 'fired' })
    const my = ++this.run
    this.phase = 'drafting'
    const self = this
    let set: CandidateSet | null = null
    try {
      set = await this.d.ensureDraft({ turnId: t.turnId, hash: t.hash, text: t.text }, { get cancelled() { return my !== self.run } })
    } catch {
      set = null
    }
    if (my !== this.run) return // cancelled, reset or superseded while drafting
    this.phase = 'idle'
    if (!set) return this.block('draft_failed')
    if (set.status !== 'final' || set.turn.turnId !== t.turnId || set.turn.transcriptHash !== t.hash) return this.block('no_current_draft')
    if (this.d.staleness(set)) return this.block('conversation_changed')
    const now2 = this.now()
    const g2 = this.guards(now2, this.det.latest) // the partner may have resumed, or the owner started writing, while we drafted
    if (!g2.ok) return this.block(g2.reason)
    const cfg = this.d.config()
    const pick = pickCandidate(set, { prefer: cfg.prefer, now: now2 })
    if (!pick.ok) return this.block(pick.reason)
    const vetoMs = clampVetoMs(cfg.vetoMs)
    this.cd = {
      set,
      cand: pick.candidate,
      startedAt: now2,
      vetoMs,
      ask: cfg.askFirst,
      expiresAt: now2 + (cfg.askFirst ? TURN_TAKING.awaitTapExpiryMs : vetoMs),
      silenceMs: clampSilenceMs(cfg.silenceMs),
    }
    this.phase = 'countdown'
    this.emit(this.countdownView(now2))
  }

  private cancelReasonFor(now: number, cd: Countdown): AutoBlockReason | null {
    const cfg = this.d.config()
    const c = this.d.context()
    if (!cfg.enabled) return 'disabled'
    if (!c.sessionActive) return 'no_session'
    if (c.listening !== 'listening') return 'not_listening'
    if (!c.online) return 'offline'
    if (BUSY_OUTPUT.has(c.outputKind)) return 'output_busy'
    if (this.det.partnerActive(now)) return 'partner_resumed'
    const latest = this.det.latest
    if (latest && latest.turnId !== cd.set.turn.turnId) return 'conversation_changed'
    if (this.d.staleness(cd.set)) return 'conversation_changed'
    if (c.composerText.trim()) return 'owner_typing'
    if (c.ownerEngaged) return 'owner_engaged'
    return null
  }

  private checkCountdown(now: number, cfg: AutoConfig) {
    const cd = this.cd
    if (!cd) {
      this.phase = 'idle'
      return
    }
    const reason = this.cancelReasonFor(now, cd)
    if (reason) return this.cancelCountdown(reason)
    if (cd.ask) {
      if (now >= cd.expiresAt) return this.cancelCountdown('expired')
      return this.emit(this.countdownView(now))
    }
    if (now - cd.startedAt >= cd.vetoMs) return void this.finalize(now, cfg)
    this.emit(this.countdownView(now))
  }

  private async finalize(now: number, cfg: AutoConfig) {
    const cd = this.cd
    if (!cd) return
    const g = this.guards(now, this.det.latest)
    if (!g.ok) return this.cancelCountdown(g.reason)
    this.ledger.record(now) // counted before the call: a failed attempt still counts toward the rate caps
    this.cd = null
    this.phase = 'speaking'
    this.emit({ phase: 'blocked', progress: 1, message: 'Saying it now…' })
    const meta: AutoApprovalMeta = { mode: 'turn_taking', silenceMs: cd.silenceMs, vetoMs: cd.vetoMs }
    void cfg
    let r: AutoSpeakResult = 'rejected'
    try {
      r = await this.d.speak(cd.set, cd.cand, meta)
    } catch {}
    this.phase = 'idle'
    if (r === 'rejected') this.block('rejected')
    else this.d.onEvent?.({ type: 'spoken' })
  }

  private cancelCountdown(reason: AutoBlockReason) {
    this.cd = null
    this.phase = 'idle'
    this.d.onEvent?.({ type: 'cancelled', reason })
    this.block(reason, false)
  }

  private block(reason: AutoBlockReason, announce = true) {
    const info = BLOCK_INFO[reason]
    if (announce) this.d.onEvent?.({ type: 'blocked', reason })
    if (info.quiet) {
      this.blocked = null
      return
    }
    this.blocked = { reason, until: this.now() + BLOCK_SHOW_MS }
  }

  // ---------------------------------------------------------------- view model
  private idleView(now: number, cfg: AutoConfig): AutoView {
    if (this.blocked) return { phase: 'blocked', progress: 0, blockedReason: this.blocked.reason, message: BLOCK_INFO[this.blocked.reason].text }
    const c = this.d.context()
    if (!c.sessionActive) return { phase: 'idle', progress: 0, message: 'Start listening to use auto turn-taking.' }
    const p = this.det.progress(now)
    if (p.phase === 'hearing') return { phase: 'hearing', progress: 0, message: 'Listening to your partner…' }
    if (p.phase === 'silence') return { phase: 'silence', progress: p.fraction, message: `Pause detected — waiting ${(cfg.silenceMs / 1000).toFixed(1)} s of quiet before suggesting a reply` }
    return { phase: 'idle', progress: 0, message: `On — I wait for a ${(clampSilenceMs(cfg.silenceMs) / 1000).toFixed(1)} s pause after your partner finishes.` }
  }

  private draftingView(): AutoView {
    return { phase: 'drafting', progress: 0, message: 'Pause detected — preparing a reply for you…' }
  }

  private countdownView(now: number): AutoView {
    const cd = this.cd!
    if (cd.ask) {
      return { phase: 'countdown', progress: Math.min(1, (now - cd.startedAt) / TURN_TAKING.awaitTapExpiryMs), candidateText: cd.cand.text, candidateIntent: cd.cand.intent, awaitTap: true, secondsLeft: Math.max(0, Math.ceil((cd.expiresAt - now) / 1000)), message: `Tap “Say it now” to speak “${cd.cand.text}”. Nothing is said unless you do.` }
    }
    const left = Math.max(0, cd.vetoMs - (now - cd.startedAt))
    return { phase: 'countdown', progress: Math.min(1, 1 - left / cd.vetoMs), candidateText: cd.cand.text, candidateIntent: cd.cand.intent, secondsLeft: Math.ceil(left / 1000), message: `Saying “${cd.cand.text}” unless you cancel (Esc).` }
  }

  private emit(v: AutoView) {
    if (sameAutoView(v, this.last)) return
    this.last = v
    this.d.onView(v)
  }
}
