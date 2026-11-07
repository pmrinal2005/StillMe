/**
 * Auto turn-taking (opt-in, OFF by default) — pure, DOM-free, time-injected so every rule is unit-tested.
 *
 *   partner stops talking ──► SilenceTurnDetector (1.5–3.0 s, configurable) ──► Groq draft (3 intent-distinct candidates)
 *     ──► pickCandidate (conservative, risk-aware) ──► safety guards ──► VETO COUNTDOWN (Cancel / Say it)
 *     ──► server-signed approval of the EXACT text ──► TTS.
 *
 * What this does NOT change (see README "Auto turn-taking"):
 *  - Nothing reaches TTS without a server-signed approval for the exact frozen text (SpeechController is still the only path).
 *  - It is a STANDING, REVOCABLE delegation the owner switches on; it is off until then, and every utterance carries a visible
 *    veto window. A detected pause is still not consent by itself: consent = the owner turned this on + did not veto in time.
 *  - It refuses to act on high-stakes subjects (medical, legal, money, consent, relationship, emergency), on any candidate that
 *    is not risk 'none', on affirmative commitments, while the owner is typing / touching the cards, and after
 *    MAX_CONSECUTIVE_AUTO replies with no human interaction (dead-man switch).
 */
import type { Candidate, CandidateSet, Intent } from './contracts'
import { isSubstantiveTurn } from './turns'

// ------------------------------------------------------------------------------------------------ limits
export const SILENCE_MIN_MS = 1500
export const SILENCE_MAX_MS = 3000
export const SILENCE_DEFAULT_MS = 2000
export const VETO_MIN_MS = 2000
export const VETO_MAX_MS = 10_000
export const VETO_DEFAULT_MS = 4000
/** How long after the silence threshold we wait for the FINAL transcript before giving up on this turn. */
export const FINAL_GRACE_MS = 1500
/** After our own voice stops, partner audio is ignored this long (room tail / echo). */
export const POST_SPEECH_QUIET_MS = 1500
export const MAX_AUTO_CHARS = 240
export const MAX_CONSECUTIVE_AUTO = 3
/** A blocked/cancelled notice stays visible this long. */
export const NOTICE_MS = 7000
/** Safety net: leave the 'speaking' phase even if the output state never reported busy. */
const SPEAK_PHASE_MAX_MS = 25_000

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
export const clampSilenceMs = (n: unknown): number => clamp(Number.isFinite(Number(n)) ? Math.round(Number(n)) : SILENCE_DEFAULT_MS, SILENCE_MIN_MS, SILENCE_MAX_MS)
export const clampVetoMs = (n: unknown): number => clamp(Number.isFinite(Number(n)) ? Math.round(Number(n)) : VETO_DEFAULT_MS, VETO_MIN_MS, VETO_MAX_MS)

export type IntentPref = 'auto' | 'continue' | 'clarify' | 'decline'
export const INTENT_PREFS: readonly IntentPref[] = ['auto', 'continue', 'clarify', 'decline'] as const
export const isIntentPref = (v: unknown): v is IntentPref => typeof v === 'string' && (INTENT_PREFS as readonly string[]).includes(v)

export interface AutoTurnConfig {
  enabled: boolean
  silenceMs: number
  vetoMs: number
  intent: IntentPref
  maxConsecutive: number
}
export const DEFAULT_AUTO_TURN: AutoTurnConfig = { enabled: false, silenceMs: SILENCE_DEFAULT_MS, vetoMs: VETO_DEFAULT_MS, intent: 'auto', maxConsecutive: MAX_CONSECUTIVE_AUTO }

export function normalizeAutoTurnConfig(c: Partial<AutoTurnConfig> | undefined): AutoTurnConfig {
  return {
    enabled: c?.enabled === true,
    silenceMs: clampSilenceMs(c?.silenceMs),
    vetoMs: clampVetoMs(c?.vetoMs),
    intent: isIntentPref(c?.intent) ? c!.intent! : 'auto',
    maxConsecutive: clamp(Math.round(Number(c?.maxConsecutive ?? MAX_CONSECUTIVE_AUTO)) || MAX_CONSECUTIVE_AUTO, 1, 10),
  }
}

// ------------------------------------------------------------------------------------------------ text helpers
const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()

/** Subjects where a machine must never speak for the owner, whoever asks (checked on the PARTNER's words AND the candidate). */
const HIGH_STAKES =
  /\b(medic\w*|prescri\w*|diagnos\w*|dose|dosage|pills?|insulin|oxygen|ventilator|suction\w*|pain|hurts?|allerg\w*|doctors?|nurses?|hospital\w*|surgery|surgeon|emergency|ambulance|911|999|112|resuscitat\w*|dnr|hospice|end of life|funeral|lawyers?|attorneys?|legal\w*|court|contracts?|lawsuit|sign here|sign (?:the|this)|consent|permission|authori[sz]e|pay\w*|money|dollars?|euros?|pounds?|price|cost|loan|bank|account number|password|pin code|credit card|buy|purchase|transfer|invest\w*|insurance|divorce|marry|marriage|love you|break up|suicid\w*|kill)\b|[$€£]\s?\d/i

/** Affirmative commitments an auto-reply must not make on the owner's behalf (a plausible reply is not the owner's intent). */
const COMMITMENT =
  /\b(yes|yeah|yep|yup|sure|definitely|absolutely|certainly|of course|i agree|i accept|i consent|i promise|i will|i'?ll|i do|deal|count me in|no problem|go ahead|sounds good|let'?s do it)\b/i

export const isHighStakesText = (s: string): boolean => HIGH_STAKES.test(s)
export const isCommitmentText = (s: string): boolean => COMMITMENT.test(s)

const QUESTION_START = /^(who|what|when|where|why|how|which|do|does|did|can|could|would|will|should|shall|is|are|am|was|were|have|has|had|may|might|wanna|want)\b/i
/** Heuristic: did the partner ask something? (final transcripts carry punctuation; fall back to a leading question word.) */
export function partnerAsked(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/\?\s*$/.test(t)) return true
  const last = t.split(/(?<=[.!?])\s+/).pop() ?? t
  return QUESTION_START.test(last.trim())
}

// ------------------------------------------------------------------------------------------------ server/client shared policy
/**
 * Links and e-mail addresses are never spoken automatically (they cannot be checked by ear and are a phishing/injection vector).
 * Plain numbers and dates ("at 5", "on March 3rd", "room 12") ARE allowed: they are ordinary conversation. Money and other
 * high-stakes specifics are still blocked by HIGH_STAKES ($5, dollars, price, pay ...) and by the `risk` category.
 */
const SPECIFICS = /https?:|www\.|\b[\w-]+\.(?:com|net|org|io|app|co|dev|me|ly|gov|edu)\b|\S+@\S+\.\S+/i

/** Policy shared by the browser (what it proposes) and the server backstop (what it will sign for an `auto` approval). */
export const TURN_TAKING = {
  silenceMs: { min: SILENCE_MIN_MS, max: SILENCE_MAX_MS },
  vetoMs: { min: VETO_MIN_MS, max: VETO_MAX_MS },
  /** Neutral continuation or clarifying question. `decline` is allowed only when the owner chose the decline style. */
  allowedIntents: ['continue', 'clarify'] as readonly Intent[],
  /** A partner turn needs at least this many words to deserve an automatic reply (mirrors isSubstantiveTurn). */
  minPartnerWords: 3,
  maxChars: MAX_AUTO_CHARS,
  /** Server-side rate cap for automatic replies per device. */
  rate: { limit: 10, windowMs: 5 * 60_000 },
} as const

/** The partner's words are about health, legal, money, consent or another matter a machine must not answer for the owner. */
export const isSensitivePartnerText = (s: string): boolean => HIGH_STAKES.test(s)

/** Server-side content check for a candidate that is about to be spoken automatically (links and e-mail addresses are blocked; numbers and dates are allowed). */
export function isAutoSpeakable(c: Pick<Candidate, 'text' | 'risk'>): boolean {
  const t = c.text.trim()
  if (!t || t.length > MAX_AUTO_CHARS) return false
  if (c.risk !== 'none') return false
  return !HIGH_STAKES.test(t) && !COMMITMENT.test(t) && !SPECIFICS.test(t)
}

// ------------------------------------------------------------------------------------------------ SilenceTurnDetector
export interface DetectorTurn { turnId: number; text: string; endOfTurn: boolean }
export type DetectorEvent =
  | { type: 'silence'; turnId: number; text: string; silentMs: number }
  | { type: 'no_final'; turnId: number }

/**
 * "Has the partner finished AND stayed quiet for N seconds?"
 * Activity = voice energy (EnergyVad) or a transcript revision that changes the WORDS (a final that only adds punctuation
 * is not activity, so the silence clock starts when the speech ended, not when the final transcript arrived).
 */
export class SilenceTurnDetector {
  private lastActivity = Number.NEGATIVE_INFINITY
  private armed = false
  private turn: (DetectorTurn & { words: string }) | null = null
  private consumedKey: string | null = null
  private suppressUntil = Number.NEGATIVE_INFINITY
  private busy = false
  private ms: number

  constructor(silenceMs: number = SILENCE_DEFAULT_MS) {
    this.ms = clampSilenceMs(silenceMs)
  }

  get silenceMs() {
    return this.ms
  }
  setSilenceMs(v: number) {
    this.ms = clampSilenceMs(v)
  }

  private ignoring(now: number) {
    return this.busy || now < this.suppressUntil
  }

  /** Voice energy heard (or any other sign the partner is still talking). */
  activity(now: number) {
    if (this.ignoring(now)) return
    this.lastActivity = now
    this.armed = true
  }

  /** A transcript message for a partner turn. */
  turnUpdate(t: DetectorTurn, now: number) {
    if (this.ignoring(now)) return
    const words = norm(t.text)
    const prev = this.turn
    const sameWords = !!prev && prev.turnId === t.turnId && prev.words === words
    this.turn = { ...t, words }
    if (!words) return
    if (!sameWords) {
      this.lastActivity = now
      this.armed = true
    } else if (!this.armed && this.consumedKey === null) {
      // identical words re-delivered (e.g. the final after the last partial) — never restarts the clock
    }
  }

  /** Our own synthetic voice is playing: nothing the mic hears counts, and the detector forgets what was pending. */
  setBusy(on: boolean, now: number) {
    if (on === this.busy) return
    this.busy = on
    if (on) {
      this.armed = false
    } else {
      this.suppressUntil = now + POST_SPEECH_QUIET_MS
      this.lastActivity = Number.NEGATIVE_INFINITY
    }
  }

  reset() {
    this.armed = false
    this.turn = null
    this.consumedKey = null
    this.lastActivity = Number.NEGATIVE_INFINITY
    this.suppressUntil = Number.NEGATIVE_INFINITY
    this.busy = false
  }

  /** Re-arm so the SAME words fire again after a re-draft decision (not used for ordinary flow). */
  forget() {
    this.consumedKey = null
  }

  /** 0..1 progress of the silence clock (for the meter). 0 when nothing is pending. */
  progress(now: number): number {
    if (!this.armed || this.busy || !this.turn || !isSubstantiveTurn(this.turn.text)) return 0
    return clamp((now - this.lastActivity) / this.ms, 0, 1)
  }

  /** True while there is a substantive, unconsumed turn waiting for its silence. */
  get pending(): boolean {
    return this.armed && !!this.turn && isSubstantiveTurn(this.turn.text)
  }

  /** Call ~5×/s. Returns an event exactly once per turn revision. */
  tick(now: number): DetectorEvent | null {
    if (!this.armed || this.ignoring(now)) return null
    const silent = now - this.lastActivity
    if (silent < this.ms) return null
    const t = this.turn
    if (!t || !isSubstantiveTurn(t.text) || this.consumedKey === `${t.turnId}:${t.words}`) {
      this.armed = false // noise, a back-channel ("uh-huh") or something already handled
      return null
    }
    if (!t.endOfTurn) {
      if (silent >= this.ms + FINAL_GRACE_MS) {
        this.armed = false
        this.consumedKey = `${t.turnId}:${t.words}`
        return { type: 'no_final', turnId: t.turnId }
      }
      return null
    }
    this.armed = false
    this.consumedKey = `${t.turnId}:${t.words}`
    return { type: 'silence', turnId: t.turnId, text: t.text, silentMs: silent }
  }
}

// ------------------------------------------------------------------------------------------------ candidate picker
export type PickResult = { ok: true; candidate: Candidate; why: string } | { ok: false; reason: string; message: string }

/** Order in which intents are tried. `auto`: a question gets a clarifying reply, a statement a neutral continuation. */
export function intentOrder(pref: IntentPref, partnerText: string): Intent[] {
  if (pref === 'continue') return ['continue', 'clarify']
  if (pref === 'clarify') return ['clarify', 'continue']
  if (pref === 'decline') return ['decline', 'clarify']
  return partnerAsked(partnerText) ? ['clarify', 'continue'] : ['continue', 'clarify']
}

/** Why a single candidate may not be spoken without the owner writing it. null = acceptable. */
export function candidateProblem(c: Candidate, pref: IntentPref): { reason: string; message: string } | null {
  if (c.risk !== 'none') return { reason: 'risk_category', message: `That draft touches a sensitive topic (${c.risk}), so I did not speak it.` }
  const text = c.text.trim()
  if (!text) return { reason: 'empty', message: 'The draft was empty.' }
  if (text.length > MAX_AUTO_CHARS) return { reason: 'too_long', message: 'The draft was too long to speak automatically.' }
  if (SPECIFICS.test(text)) return { reason: 'specifics', message: 'That draft contains a link or e-mail address, so I did not speak it.' }
  if (isHighStakesText(text)) return { reason: 'high_stakes_candidate', message: 'That draft mentions a high-stakes subject, so I did not speak it.' }
  // Committing words are blocked for every intent except an explicit "decline" preference (declining is the owner's own choice).
  if (pref !== 'decline' && isCommitmentText(text)) return { reason: 'commitment', message: 'That draft agrees to something on your behalf, so I did not speak it.' }
  return null
}

/** Choose the safest suitable candidate, or explain why none is. */
export function pickCandidate(set: Pick<CandidateSet, 'candidates'>, opts: { intent: IntentPref; partnerText: string }): PickResult {
  if (isHighStakesText(opts.partnerText)) {
    return { ok: false, reason: 'high_stakes_partner', message: 'Your partner mentioned something high-stakes (health, legal, money or consent). Please reply in your own words.' }
  }
  const order = intentOrder(opts.intent, opts.partnerText)
  let firstProblem: { reason: string; message: string } | null = null
  for (const want of order) {
    for (const c of set.candidates) {
      if (c.intent !== want) continue
      const p = candidateProblem(c, opts.intent)
      if (!p) return { ok: true, candidate: c, why: want }
      firstProblem ??= p
    }
  }
  return { ok: false, reason: firstProblem?.reason ?? 'no_suitable_candidate', message: firstProblem?.message ?? 'None of the drafts was safe to speak automatically.' }
}

// ------------------------------------------------------------------------------------------------ live guards
export interface LiveCtx {
  /** What is in the composer right now (the owner is writing something). */
  composerText: string
  /** The owner is interacting with the suggestion cards (EngageTracker lease live). */
  engaged: boolean
  /** Our own output is currently speaking / holding. */
  outputBusy: boolean
  online: boolean
  /** The suggestion set still answers the newest partner turn (Conversation Brake). */
  fresh: boolean
}
export type GuardResult = { ok: true } | { ok: false; reason: string; message: string }

/** Final yes/no immediately before audio is requested, and again every tick of the veto countdown. */
export function liveGuard(ctx: LiveCtx): GuardResult {
  if (!ctx.online) return { ok: false, reason: 'offline', message: 'You are offline, so nothing was spoken.' }
  if (ctx.composerText.trim()) return { ok: false, reason: 'user_typing', message: 'You started writing, so the automatic reply was cancelled.' }
  if (ctx.engaged) return { ok: false, reason: 'user_engaged', message: 'You were choosing a suggestion, so the automatic reply was cancelled.' }
  if (ctx.outputBusy) return { ok: false, reason: 'output_busy', message: 'Something is already being spoken.' }
  if (!ctx.fresh) return { ok: false, reason: 'stale', message: 'The conversation moved on, so that reply was dropped.' }
  return { ok: true }
}

// ------------------------------------------------------------------------------------------------ controller
export type AutoTurnPhase = 'off' | 'idle' | 'listening' | 'drafting' | 'countdown' | 'speaking'

export interface AutoPick {
  turnId: number
  partnerText: string
  setId: string
  candidateId: string
  text: string
  intent: Intent
}

export type AutoTurnAction =
  | { type: 'draft'; turnId: number; text: string }
  | { type: 'speak'; pick: AutoPick; viaSayIt: boolean }

export interface AutoTurnNotice { kind: 'blocked' | 'cancelled' | 'info'; reason: string; message: string; at: number }

export interface AutoTurnSnapshot {
  enabled: boolean
  phase: AutoTurnPhase
  silenceMs: number
  vetoMs: number
  /** 0..1: silence elapsed since the partner stopped. */
  silenceProgress: number
  /** 0..1 and remaining milliseconds of the veto countdown. */
  vetoProgress: number
  vetoRemainingMs: number
  pick: AutoPick | null
  consecutive: number
  maxConsecutive: number
  notice: AutoTurnNotice | null
}

/**
 * The auto turn-taking state machine. Pure: the app feeds it events and ticks, and does what the returned action says.
 *  off ─enable→ idle ─voice/transcript→ listening ─silence→ drafting ─draftReady→ countdown ─elapsed|Say it→ speaking ─idle→ idle
 *  Any partner activity during drafting/countdown drops the draft (Conversation Brake: the context just changed).
 */
export class AutoTurnController {
  private cfg: AutoTurnConfig
  private det: SilenceTurnDetector
  private ph: AutoTurnPhase
  private pick: AutoPick | null = null
  private deadline = 0
  private countdownStart = 0
  private consecutive = 0
  private note: AutoTurnNotice | null = null
  private speakAt = 0
  private sawBusy = false
  /** Did the utterance now in flight count toward the dead-man limit? (Say it = a human decision = it does not.) */
  private counted = false
  private pendingTurn: { turnId: number; text: string } | null = null

  constructor(cfg: Partial<AutoTurnConfig> = {}) {
    this.cfg = normalizeAutoTurnConfig(cfg)
    this.det = new SilenceTurnDetector(this.cfg.silenceMs)
    this.ph = this.cfg.enabled ? 'idle' : 'off'
  }

  get phase() {
    return this.ph
  }
  get config() {
    return this.cfg
  }

  setConfig(c: Partial<AutoTurnConfig>, now: number = Date.now()) {
    const next = normalizeAutoTurnConfig({ ...this.cfg, ...c })
    const wasEnabled = this.cfg.enabled
    this.cfg = next
    this.det.setSilenceMs(next.silenceMs)
    if (!next.enabled) {
      this.dropPending()
      this.det.reset()
      this.consecutive = 0
      this.note = null
      this.ph = 'off'
    } else if (!wasEnabled) {
      this.det.reset()
      this.consecutive = 0
      this.ph = 'idle'
      void now
    }
  }

  /** New listening session / reconnect: forget everything pending (the dead-man counter stays — no human acted). */
  reset() {
    this.dropPending()
    this.det.reset()
    this.note = null
    this.ph = this.cfg.enabled ? 'idle' : 'off'
  }

  private dropPending() {
    this.pick = null
    this.pendingTurn = null
    this.deadline = 0
  }

  private setNotice(kind: AutoTurnNotice['kind'], reason: string, message: string, now: number) {
    this.note = { kind, reason, message, at: now }
  }

  /** Voice energy / another sign that the partner is talking. */
  partnerActivity(now: number) {
    if (!this.cfg.enabled) return
    if (this.ph === 'speaking') return
    if (this.ph === 'drafting' || this.ph === 'countdown') {
      this.dropPending()
      this.det.activity(now)
      this.ph = 'listening'
      this.setNotice('cancelled', 'partner_resumed', 'Your partner kept talking, so that draft was dropped. I will draft again when they pause.', now)
      // No forget(): if they really continued, the transcript words change and the detector fires again by itself; a bare
      // noise/cough must not re-draft identical words (wasted Groq call, possible loop).
      return
    }
    this.det.activity(now)
    if (this.det.pending || this.ph === 'idle') this.ph = 'listening'
  }

  /** Transcript message for a partner turn (partial or final). */
  partnerTurn(t: DetectorTurn, now: number) {
    if (!this.cfg.enabled || this.ph === 'speaking') return
    const before = this.det.pending
    this.det.turnUpdate(t, now)
    if ((this.ph === 'drafting' || this.ph === 'countdown') && this.pendingTurn && (t.turnId !== this.pendingTurn.turnId || norm(t.text) !== norm(this.pendingTurn.text))) {
      // The words changed under the draft: it answers something the partner no longer said.
      this.dropPending()
      this.ph = 'listening'
      this.det.forget()
      this.setNotice('cancelled', 'partner_resumed', 'The transcript changed, so that draft was dropped.', now)
      return
    }
    if (this.det.pending && !before && this.ph === 'idle') this.ph = 'listening'
  }

  /** The owner did something deliberate (typed, pressed a button, picked a card): the dead-man counter restarts. */
  userInteracted() {
    this.consecutive = 0
    if (this.note?.reason === 'consecutive_limit') this.note = null
  }

  /** The owner pressed OK on the notice: hides it, and counts as a deliberate action. */
  dismissNotice() {
    this.note = null
    this.consecutive = 0
  }

  /** Owner veto during drafting/countdown. Returns what was about to be spoken so the app can put it in the composer. */
  cancel(reason: string = 'user_cancel', now: number = Date.now()): AutoPick | null {
    const p = this.pick
    if (this.ph !== 'drafting' && this.ph !== 'countdown') return null
    this.dropPending()
    this.consecutive = 0 // a human is clearly present
    this.ph = this.cfg.enabled ? 'idle' : 'off'
    this.setNotice('cancelled', reason, reason === 'user_cancel' ? 'Cancelled. Nothing was spoken — the draft is in the message box if you want it.' : 'Cancelled. Nothing was spoken.', now)
    return p
  }

  /** "Say it": skip the rest of the countdown. The caller still obtains a server-signed approval for the exact text. */
  sayNow(): AutoTurnAction | null {
    if (this.ph !== 'countdown' || !this.pick) return null
    this.consecutive = 0 // pressing Say it is a human decision
    return this.startSpeaking(Date.now(), true)
  }

  private startSpeaking(now: number, viaSayIt: boolean): AutoTurnAction {
    const pick = this.pick!
    // SpeechController.request() resolves only AFTER playback, by which time tick() has already left 'speaking' — so the
    // attempt is counted when it STARTS and refunded in speakResult() if nothing was spoken.
    this.counted = !viaSayIt
    if (this.counted) this.consecutive += 1
    this.ph = 'speaking'
    this.speakAt = now
    this.sawBusy = false
    this.pick = null
    this.pendingTurn = null
    this.deadline = 0
    return { type: 'speak', pick, viaSayIt }
  }

  /** The app produced a candidate set for the turn it was asked to draft. */
  draftReady(args: { set: Pick<CandidateSet, 'id' | 'candidates'>; turnId: number; partnerText: string }, now: number): GuardResult {
    if (this.ph !== 'drafting' || !this.pendingTurn || this.pendingTurn.turnId !== args.turnId) return { ok: false, reason: 'stale', message: 'stale' }
    const r = pickCandidate(args.set, { intent: this.cfg.intent, partnerText: args.partnerText })
    if (!r.ok) {
      this.dropPending()
      this.ph = 'idle'
      this.setNotice('blocked', r.reason, r.message, now)
      return r
    }
    this.pick = { turnId: args.turnId, partnerText: args.partnerText, setId: args.set.id, candidateId: r.candidate.id, text: r.candidate.text, intent: r.candidate.intent }
    this.countdownStart = now
    this.deadline = now + this.cfg.vetoMs
    this.ph = 'countdown'
    this.setNotice('info', 'countdown', 'Speaking in a moment — Cancel to stop it, or Say it to speak now.', now)
    return { ok: true }
  }

  draftFailed(reason: string, message: string, now: number) {
    if (this.ph !== 'drafting') return
    this.dropPending()
    this.ph = 'idle'
    this.setNotice('blocked', reason, message, now)
  }

  /** Call ~5×/s with the live context. Returns at most one action. */
  tick(now: number, ctx: LiveCtx): AutoTurnAction | null {
    if (!this.cfg.enabled) return null
    // Our own voice: mute the detector for its duration (+ tail) and leave 'speaking' when it is over.
    this.det.setBusy(ctx.outputBusy || this.ph === 'speaking', now)
    if (this.ph === 'speaking') {
      if (ctx.outputBusy) this.sawBusy = true
      if ((this.sawBusy && !ctx.outputBusy) || now - this.speakAt > SPEAK_PHASE_MAX_MS) {
        this.det.setBusy(false, now)
        this.ph = 'idle'
      }
      return null
    }
    if (this.note && now - this.note.at > NOTICE_MS && this.note.reason !== 'consecutive_limit') this.note = null

    if (this.ph === 'countdown' && this.pick) {
      const g = liveGuard({ ...ctx, outputBusy: ctx.outputBusy, fresh: ctx.fresh })
      if (!g.ok) {
        this.dropPending()
        this.ph = 'idle'
        this.setNotice('cancelled', g.reason, g.message, now)
        return null
      }
      if (now >= this.deadline) return this.startSpeaking(now, false)
      return null
    }
    if (this.ph === 'drafting') return null

    const ev = this.det.tick(now)
    if (!ev) {
      if (this.ph === 'listening' && !this.det.pending) this.ph = 'idle'
      return null
    }
    if (ev.type === 'no_final') {
      this.ph = 'idle'
      this.setNotice('blocked', 'no_final', 'I did not get a final transcript for that turn, so I did not reply.', now)
      return null
    }
    if (this.consecutive >= this.cfg.maxConsecutive) {
      this.ph = 'idle'
      this.setNotice('blocked', 'consecutive_limit', `I paused automatic replies after ${this.cfg.maxConsecutive} in a row with no input from you. Press any button or type to continue.`, now)
      return null
    }
    if (isHighStakesText(ev.text)) {
      this.ph = 'idle'
      this.setNotice('blocked', 'high_stakes_partner', 'Your partner mentioned something high-stakes (health, legal, money or consent). Please reply in your own words.', now)
      return null
    }
    const g = liveGuard({ ...ctx, fresh: true })
    if (!g.ok) {
      this.ph = 'idle'
      this.setNotice('blocked', g.reason, g.message, now)
      return null
    }
    this.pendingTurn = { turnId: ev.turnId, text: ev.text }
    this.ph = 'drafting'
    return { type: 'draft', turnId: ev.turnId, text: ev.text }
  }

  /**
   * `result`: what SpeechController.request returned (may arrive after playback finished, i.e. in any phase).
   * Anything that did not result in audio refunds the dead-man counter and leaves a notice; the owner's words are untouched.
   * 'stopped' is the owner pressing Stop — a human is present, so the counter resets.
   */
  speakResult(result: string, now: number) {
    const failed = result in SPEAK_FAIL_MESSAGE
    if (!failed) return
    if (this.counted) {
      this.consecutive = Math.max(0, this.consecutive - 1)
      this.counted = false
    }
    if (result === 'stopped') this.consecutive = 0
    if (this.ph === 'speaking') {
      this.ph = this.cfg.enabled ? 'idle' : 'off'
      this.det.setBusy(false, now)
    }
    this.setNotice('blocked', `speak_${result}`, SPEAK_FAIL_MESSAGE[result] ?? `Nothing was spoken (${result}).`, now)
  }

  snapshot(now: number): AutoTurnSnapshot {
    const total = Math.max(1, this.deadline - this.countdownStart)
    const remaining = this.ph === 'countdown' ? Math.max(0, this.deadline - now) : 0
    return {
      enabled: this.cfg.enabled,
      phase: this.ph,
      silenceMs: this.cfg.silenceMs,
      vetoMs: this.cfg.vetoMs,
      silenceProgress: this.ph === 'listening' ? this.det.progress(now) : this.ph === 'drafting' || this.ph === 'countdown' ? 1 : 0,
      vetoProgress: this.ph === 'countdown' ? clamp(1 - remaining / total, 0, 1) : 0,
      vetoRemainingMs: remaining,
      pick: this.pick,
      consecutive: this.consecutive,
      maxConsecutive: this.cfg.maxConsecutive,
      notice: this.note,
    }
  }
}

const SPEAK_FAIL_MESSAGE: Record<string, string> = {
  rejected: 'The server did not approve that reply, so nothing was spoken.',
  busy: 'Something else was already being said, so nothing was spoken.',
  stopped: 'Stopped. Nothing more was spoken.',
  error: 'The voice could not speak that, so nothing was said.',
  uncertain: 'The connection dropped while speaking — part of it may have been heard. It will not be repeated automatically.',
  stale: 'The conversation moved on before it could be spoken, so nothing was said.',
  offline: 'You are offline, so nothing was spoken.',
}

export const AUTO_PHASE_LABEL: Record<AutoTurnPhase, string> = {
  off: 'Auto turn-taking is off',
  idle: 'Waiting for your partner',
  listening: 'Partner is talking — waiting for a pause',
  drafting: 'Pause detected — drafting a reply',
  countdown: 'Speaking soon unless you cancel',
  speaking: 'Speaking your approved words',
}
