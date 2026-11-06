/**
 * Intersecting budget limits. The scheduler enforces whichever constraint binds first.
 *
 * These are APPLICATION ledgers, not provider-enforced account caps. Reconcile with the
 * AssemblyAI / Groq / LiveKit dashboards; disclose remaining risk to the owner.
 */

export const PRICES = {
  sttFlagshipPerHour: 0.45, // Universal-3.6 Pro Realtime
  sttEconomyPerHour: 0.15, // Universal-Streaming English / Multilingual
  ttsPerChar: 0.000015, // incl. spaces and punctuation
} as const

export const LIMITS = {
  groq: {
    outstandingPerConversation: 1,
    callsPerPartnerTurn: 2,
    requestsPerMinute: 6,
    requestsPerDay: 200,
    maxInputTokens: 500,
    maxOutputTokens: 180,
    dailyTokens: 100_000,
  },
  assembly: {
    interactiveSessionMinutes: 20,
    dailyFlagshipListeningMinutes: 40,
    dailyTtsChars: 5_000,
    dailyUsd: 1.0,
    totalCreditUsd: 100,
    protectedReserveUsd: 15, // never automatically spent
  },
  livekit: {
    monthlyAgentMinutes: 1000,
    plannedAgentMinutes: 840,
    monthlyInboundPhoneMinutes: 40, // of the 50 included, leaving 10 headroom
  },
} as const

type Widen<T> = { -readonly [K in keyof T]: T[K] extends number ? number : Widen<T[K]> }
/** Same shape as LIMITS with plain numbers, so reduced ledgers (e.g. guests) can be constructed. */
export type Limits = Widen<typeof LIMITS>

/**
 * E47: PROJECT-wide daily limits. They used to be the SAME numbers as the per-user limits (the project ledger was built
 * from LIMITS), so ONE account could consume the whole project's day and the project cap protected nothing. Per-user
 * caps are the fair share; the project caps bound the SUM of all users (a small multiple of one user, never the
 * provider-wide spend the owner is willing to lose in a day).
 */
export const PROJECT_LIMITS: Limits = {
  groq: { ...LIMITS.groq },
  assembly: {
    ...LIMITS.assembly,
    dailyTtsChars: LIMITS.assembly.dailyTtsChars * 2,
    dailyFlagshipListeningMinutes: LIMITS.assembly.dailyFlagshipListeningMinutes * 2,
    dailyUsd: LIMITS.assembly.dailyUsd * 3,
  },
  livekit: { ...LIMITS.livekit },
}

/** F: streaming-STT profile. `flagship` = Universal-3.6 Pro Realtime; `economy` = Universal-Streaming (English / multilingual). */
export type SttProfile = 'flagship' | 'economy'
export const sttRatePerHour = (p: SttProfile | undefined | null): number => (p === 'economy' ? PRICES.sttEconomyPerHour : PRICES.sttFlagshipPerHour)

/**
 * NO SIGN-IN: there are no accounts, so every visitor is a device. Each device gets the normal per-device LIMITS, and all
 * devices behind the same network (HMAC of the client IP) share ONE pool, so clearing cookies / opening a private window
 * cannot mint a fresh allowance. The pool is 1.5x one device (a household can share it) and stays below the project-wide
 * PROJECT_LIMITS (2x), which still bound the sum of everybody.
 */
export const NETWORK_POOL_LIMITS: Limits = {
  groq: { ...LIMITS.groq, requestsPerDay: 120, dailyTokens: 60_000, requestsPerMinute: 6, outstandingPerConversation: 4, callsPerPartnerTurn: 2 },
  assembly: { ...LIMITS.assembly, dailyTtsChars: LIMITS.assembly.dailyTtsChars * 1.5, dailyUsd: LIMITS.assembly.dailyUsd * 1.5, dailyFlagshipListeningMinutes: LIMITS.assembly.dailyFlagshipListeningMinutes * 1.5 },
  livekit: { ...LIMITS.livekit },
}

export function estimateAssemblyUsd(u: { flagshipHours?: number; economyHours?: number; ttsChars?: number }): number {
  return (
    (u.flagshipHours ?? 0) * PRICES.sttFlagshipPerHour +
    (u.economyHours ?? 0) * PRICES.sttEconomyPerHour +
    (u.ttsChars ?? 0) * PRICES.ttsPerChar
  )
}

/** Rough token estimate (≈4 chars/token for English). Used for pre-flight reservations only. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export type DenyReason =
  | 'groq_outstanding'
  | 'groq_turn_cap'
  | 'groq_rpm'
  | 'groq_rpd'
  | 'groq_daily_tokens'
  | 'groq_retry_after'
  | 'tts_daily_chars'
  | 'assembly_daily_usd'
  | 'assembly_reserve'
  | 'stt_daily_minutes'

interface DayState {
  day: string
  groqRequests: number
  groqTokens: number
  ttsChars: number
  sttMinutes: number
  usd: number
}

export function dayKey(now: number) {
  return new Date(now).toISOString().slice(0, 10)
}

/**
 * In-process ledger with transactional reservations: reserve() before calling a provider,
 * then commit(actual) or release(). For multi-instance deploys back this with the Supabase
 * `budget_reservations` table (see supabase/migrations) — same semantics.
 */
export class BudgetLedger {
  private days = new Map<string, DayState>()
  private minuteWindow: number[] = []
  private outstanding = new Map<string, number>() // conversationId -> in-flight count
  private perTurn = new Map<string, number>() // `${conv}:${gen}:${turn}` -> calls
  private retryAfterUntil = 0
  private reservations = new Map<string, { key: string; kind: 'groq' | 'tts'; tokens: number; chars: number; usd: number; conv?: string; turnKey?: string }>()
  /** Lifetime spend estimate across days (for reserve protection). Seed from DB in production. */
  public lifetimeUsd = 0

  constructor(private limits: Limits = LIMITS) {}

  private state(now: number, key?: string): DayState {
    const day = key ?? dayKey(now)
    let s = this.days.get(day)
    if (!s) {
      s = { day, groqRequests: 0, groqTokens: 0, ttsChars: 0, sttMinutes: 0, usd: 0 }
      this.days.set(day, s)
      for (const k of this.days.keys()) if (k < day) this.days.delete(k)
    }
    return s
  }

  noteRetryAfter(seconds: number, now = Date.now()) {
    this.retryAfterUntil = Math.max(this.retryAfterUntil, now + seconds * 1000)
  }

  snapshot(now = Date.now()) {
    const s = this.state(now)
    const g = this.limits.groq
    const a = this.limits.assembly
    return {
      day: s.day,
      groq: { requests: s.groqRequests, requestsLimit: g.requestsPerDay, tokens: s.groqTokens, tokensLimit: g.dailyTokens, retryAfterUntil: this.retryAfterUntil },
      tts: { chars: s.ttsChars, charsLimit: a.dailyTtsChars },
      stt: { minutes: s.sttMinutes, minutesLimit: a.dailyFlagshipListeningMinutes },
      usd: { today: +s.usd.toFixed(4), todayLimit: a.dailyUsd, lifetime: +this.lifetimeUsd.toFixed(4), spendable: a.totalCreditUsd - a.protectedReserveUsd },
    }
  }

  reserveGroq(opts: { conversationId: string; turnKey: string; inputTokens: number; now?: number }): { ok: true; id: string } | { ok: false; reason: DenyReason; retryAfterMs?: number } {
    const now = opts.now ?? Date.now()
    const g = this.limits.groq
    if (now < this.retryAfterUntil) return { ok: false, reason: 'groq_retry_after', retryAfterMs: this.retryAfterUntil - now }
    if ((this.outstanding.get(opts.conversationId) ?? 0) >= g.outstandingPerConversation) return { ok: false, reason: 'groq_outstanding' }
    if ((this.perTurn.get(opts.turnKey) ?? 0) >= g.callsPerPartnerTurn) return { ok: false, reason: 'groq_turn_cap' }
    this.minuteWindow = this.minuteWindow.filter((t) => now - t < 60_000)
    if (this.minuteWindow.length >= g.requestsPerMinute) return { ok: false, reason: 'groq_rpm', retryAfterMs: 60_000 - (now - this.minuteWindow[0]) }
    const s = this.state(now)
    if (s.groqRequests >= g.requestsPerDay) return { ok: false, reason: 'groq_rpd' }
    const tokens = Math.min(opts.inputTokens, g.maxInputTokens) + g.maxOutputTokens
    if (s.groqTokens + tokens > g.dailyTokens) return { ok: false, reason: 'groq_daily_tokens' }
    // reserve
    const id = `${now}-${Math.random().toString(36).slice(2)}`
    this.minuteWindow.push(now)
    s.groqRequests += 1
    s.groqTokens += tokens
    this.outstanding.set(opts.conversationId, (this.outstanding.get(opts.conversationId) ?? 0) + 1)
    this.perTurn.set(opts.turnKey, (this.perTurn.get(opts.turnKey) ?? 0) + 1)
    if (this.perTurn.size > 500) this.perTurn.delete(this.perTurn.keys().next().value!)
    this.reservations.set(id, { key: s.day, kind: 'groq', tokens, chars: 0, usd: 0, conv: opts.conversationId, turnKey: opts.turnKey })
    return { ok: true, id }
  }

  /** Commit with actual token usage (from the provider's `usage` field). */
  commitGroq(id: string, actualTokens?: number) {
    const r = this.reservations.get(id)
    if (!r) return
    this.reservations.delete(id)
    if (r.conv) this.outstanding.set(r.conv, Math.max(0, (this.outstanding.get(r.conv) ?? 1) - 1))
    if (actualTokens !== undefined) {
      const s = this.state(Date.now(), r.key)
      s.groqTokens += actualTokens - r.tokens
    }
  }

  /** Release a reservation that never reached the provider (keeps the request count — it was attempted). */
  releaseGroq(id: string, opts: { refundTurn?: boolean } = {}) {
    const turnKey = this.reservations.get(id)?.turnKey
    this.commitGroq(id, 0)
    // C #27: a call that produced NO candidates (Groq 5xx / 429 / bad output) must not use up one of the per-turn calls,
    // otherwise the owner's single bounded FINAL retry is refused as `groq_turn_cap`. The request itself stays counted
    // against rpm / daily requests, so a flapping provider is still bounded.
    if (opts.refundTurn && turnKey) {
      const n = (this.perTurn.get(turnKey) ?? 0) - 1
      if (n > 0) this.perTurn.set(turnKey, n)
      else this.perTurn.delete(turnKey)
    }
  }

  /**
   * C #27: a request that was SUPERSEDED (aborted by a newer one) before Groq answered did no useful work. Give back
   * everything: the in-flight slot, the tokens, the request count, the rpm slot AND the per-turn call slot — otherwise
   * a superseded provisional draft burns one of the two per-turn calls and the FINAL retry is refused as `groq_turn_cap`.
   */
  refundGroq(id: string) {
    const r = this.reservations.get(id)
    if (!r) return
    this.reservations.delete(id)
    if (r.conv) this.outstanding.set(r.conv, Math.max(0, (this.outstanding.get(r.conv) ?? 1) - 1))
    const s = this.state(Date.now(), r.key)
    s.groqTokens = Math.max(0, s.groqTokens - r.tokens)
    s.groqRequests = Math.max(0, s.groqRequests - 1)
    if (r.turnKey) {
      const n = (this.perTurn.get(r.turnKey) ?? 0) - 1
      if (n > 0) this.perTurn.set(r.turnKey, n)
      else this.perTurn.delete(r.turnKey)
    }
    this.minuteWindow.pop()
  }

  reserveTts(chars: number, now = Date.now()): { ok: true; id: string } | { ok: false; reason: DenyReason } {
    const a = this.limits.assembly
    const s = this.state(now)
    const usd = chars * PRICES.ttsPerChar
    if (s.ttsChars + chars > a.dailyTtsChars) return { ok: false, reason: 'tts_daily_chars' }
    if (s.usd + usd > a.dailyUsd) return { ok: false, reason: 'assembly_daily_usd' }
    if (this.lifetimeUsd + usd > a.totalCreditUsd - a.protectedReserveUsd) return { ok: false, reason: 'assembly_reserve' }
    const id = `${now}-${Math.random().toString(36).slice(2)}`
    s.ttsChars += chars
    s.usd += usd
    this.lifetimeUsd += usd
    this.reservations.set(id, { key: s.day, kind: 'tts', tokens: 0, chars, usd })
    return { ok: true, id }
  }

  /** Commit with billed characters reported by the provider (X-TTS-Billed-Characters). */
  commitTts(id: string, billedChars?: number) {
    const r = this.reservations.get(id)
    if (!r) return
    this.reservations.delete(id)
    if (billedChars !== undefined && billedChars !== r.chars) {
      const s = this.state(Date.now(), r.key)
      const delta = billedChars - r.chars
      s.ttsChars += delta
      s.usd += delta * PRICES.ttsPerChar
      this.lifetimeUsd += delta * PRICES.ttsPerChar
    }
  }

  /** Errors before audio are not billed by AssemblyAI → refund the reservation. */
  releaseTts(id: string) {
    this.commitTts(id, 0)
  }

  /** Reserve listening minutes for a bounded session; returns the allowed minutes (0 = deny). */
  reserveSttMinutes(requested: number, now = Date.now(), profile: SttProfile = 'flagship'): { ok: true; minutes: number } | { ok: false; reason: DenyReason } {
    const a = this.limits.assembly
    const s = this.state(now)
    const left = a.dailyFlagshipListeningMinutes - s.sttMinutes
    const minutes = Math.min(requested, a.interactiveSessionMinutes, left)
    if (minutes <= 0) return { ok: false, reason: 'stt_daily_minutes' }
    const usd = (minutes / 60) * sttRatePerHour(profile)
    if (s.usd + usd > a.dailyUsd) return { ok: false, reason: 'assembly_daily_usd' }
    if (this.lifetimeUsd + usd > a.totalCreditUsd - a.protectedReserveUsd) return { ok: false, reason: 'assembly_reserve' }
    s.sttMinutes += minutes
    s.usd += usd
    this.lifetimeUsd += usd
    return { ok: true, minutes }
  }

  /**
   * B3: settle a listening reservation. `usedMinutes` stays charged; the rest is refunded.
   * Pass usedMinutes = 0 for a session that never started (room/dispatch failure).
   * `day` is the UTC day the reservation was made (YYYY-MM-DD); refunds never go below zero.
   */
  releaseSttMinutes(reservedMinutes: number, usedMinutes = 0, day?: string, now = Date.now(), profile: SttProfile = 'flagship') {
    const refund = Math.max(0, reservedMinutes - Math.max(0, usedMinutes))
    if (refund <= 0) return 0
    const key = day ?? dayKey(now)
    const s = this.days.get(key)
    if (!s) return 0 // day already rolled over — nothing outstanding to refund
    const minutes = Math.min(refund, s.sttMinutes)
    const usd = (minutes / 60) * sttRatePerHour(profile)
    s.sttMinutes -= minutes
    s.usd = Math.max(0, s.usd - usd)
    this.lifetimeUsd = Math.max(0, this.lifetimeUsd - usd)
    return minutes
  }
}
