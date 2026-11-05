/**
 * C #29 — "engaged" (the owner is interacting with the suggestion cards) must EXPIRE.
 *
 * Selection stability says: never swap the cards under the owner's finger. The flag used to be set on the first focus or
 * pointer-down and was only cleared by speaking or accepting a replacement — so after one touch EVERY later suggestion set
 * was parked as "updated suggestions available" forever, even minutes later and across partner turns. Now engagement is a
 * short lease that every interaction renews, and that is dropped by explicit events (spoke, accepted the replacement,
 * session ended/started).
 */
export const ENGAGE_MS = 8_000

export class EngageTracker {
  private at = Number.NEGATIVE_INFINITY
  constructor(private leaseMs = ENGAGE_MS) {}

  /** The owner focused / pressed / scanned onto a suggestion card. */
  touch(now = Date.now()) {
    this.at = now
  }

  active(now = Date.now()): boolean {
    return now - this.at < this.leaseMs
  }

  reset() {
    this.at = Number.NEGATIVE_INFINITY
  }
}
