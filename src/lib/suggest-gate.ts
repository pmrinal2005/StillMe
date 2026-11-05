/**
 * C #27 / #28 — per-partner-turn suggestion call budget, kept honest on the client.
 *
 * Policy (mirrors the server's `callsPerPartnerTurn`): at most CALLS_PER_TURN suggestion requests per partner turn.
 *  - #27 a request that produced NOTHING (aborted because a newer one superseded it, network/Groq failure) gives its slot
 *        back — it used to burn one of the two calls, so the FINAL transcript's request was refused;
 *  - #27 the FINAL request gets ONE bounded retry after a transient failure;
 *  - #28 when the limit is reached the owner is TOLD (the Redraft button used to do nothing, silently).
 * Pure state — no timers, no DOM — so it is unit-tested.
 */
export const CALLS_PER_TURN = 2
export const FINAL_RETRY_MAX = 1
export const FINAL_RETRY_MIN_MS = 1_500
export const FINAL_RETRY_MAX_MS = 8_000

interface TurnCalls {
  n: number
  finalDone: boolean
  lastHash?: string
  finalRetries: number
  /** a provisional (partial-transcript) draft was already ATTEMPTED — even a failed one is not auto-retried every second */
  provisionalTried: boolean
}

export class SuggestionGate {
  private m = new Map<number, TurnCalls>()
  constructor(private limit = CALLS_PER_TURN) {}

  private get(turnId: number): TurnCalls {
    let c = this.m.get(turnId)
    if (!c) {
      c = { n: 0, finalDone: false, finalRetries: 0, provisionalTried: false }
      this.m.set(turnId, c)
      if (this.m.size > 40) this.m.delete(this.m.keys().next().value!)
    }
    return c
  }

  /** Calls the owner can still make for this turn (shown next to the Redraft button). */
  remaining(turnId: number | undefined): number {
    if (turnId === undefined) return this.limit
    return Math.max(0, this.limit - (this.m.get(turnId)?.n ?? 0))
  }

  /** Reserve one call. `'limit'` when this turn has used them all. */
  begin(turnId: number, final: boolean, hash: string): 'ok' | 'limit' {
    const c = this.get(turnId)
    if (c.n >= this.limit) return 'limit'
    c.n += 1
    if (final) c.finalDone = true
    else c.provisionalTried = true
    c.lastHash = hash
    return 'ok'
  }

  /** The call produced no candidates (aborted / superseded / failed): hand the slot back and allow a re-draft of it. */
  fail(turnId: number, final: boolean, hash?: string) {
    const c = this.m.get(turnId)
    if (!c) return
    c.n = Math.max(0, c.n - 1)
    if (final) c.finalDone = false
    if (hash === undefined || c.lastHash === hash) c.lastHash = undefined // never clobber a NEWER request's marker
  }

  /** Auto-drafting: skip a final request that would redraft exactly what was already drafted. */
  alreadyDrafted(turnId: number, hash: string): boolean {
    const c = this.m.get(turnId)
    return !!c && (c.finalDone || c.lastHash === hash)
  }

  /** Auto-drafting: a provisional draft is attempted at most once before the final (failed attempts included). */
  hasProvisionalAttempt(turnId: number): boolean {
    const c = this.m.get(turnId)
    return !!c && (c.provisionalTried || c.n > 0)
  }

  /** The FINAL request failed transiently: may it retry (once)? Consumes the retry. */
  takeFinalRetry(turnId: number): boolean {
    const c = this.get(turnId)
    if (c.finalRetries >= FINAL_RETRY_MAX) return false
    c.finalRetries += 1
    return true
  }

  clear() {
    this.m.clear()
  }
}

/** Codes (ApiError.code) that mean "the provider hiccuped" — a single later retry is reasonable. */
const RETRYABLE = new Set(['groq_error', 'groq_rpm', 'groq_retry_after', 'groq_outstanding', 'http_502', 'http_503', 'http_504', 'http_429'])

export function isRetryableSuggestError(code: string, networkError = false): boolean {
  return networkError || RETRYABLE.has(code)
}

/** Delay before the one final retry: honour the server's retry-after, bounded. */
export function finalRetryDelayMs(retryAfterMs?: number): number {
  const d = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? retryAfterMs : FINAL_RETRY_MIN_MS
  return Math.min(FINAL_RETRY_MAX_MS, Math.max(FINAL_RETRY_MIN_MS, d))
}
