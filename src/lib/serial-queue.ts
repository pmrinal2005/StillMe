/**
 * C #30 — strictly ordered async work.
 *
 * Partner turn messages are handled by an ASYNC function (it hashes the text before applying it). The data channel
 * delivers messages in order, but two overlapping async handlers can finish out of order: a short hash for a later
 * revision could resolve before an earlier one and the OLDER text then overwrote the NEWER one on screen and in the
 * suggestion drafting. Every handler now runs through this queue: one at a time, in arrival order.
 *
 * `clear()` abandons everything not yet started (session ended / replaced) without breaking the chain.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve()
  private epoch = 0
  private pendingCount = 0

  constructor(private onError?: (e: unknown) => void) {}

  get pending() {
    return this.pendingCount
  }

  push(task: () => Promise<void> | void): Promise<void> {
    const mine = this.epoch
    this.pendingCount += 1
    const run = this.tail
      .then(async () => {
        if (mine !== this.epoch) return // abandoned by clear()
        await task()
      })
      .catch((e) => this.onError?.(e))
      .finally(() => {
        this.pendingCount -= 1
      })
    this.tail = run
    return run
  }

  /** Drop every queued (not yet started) task. A task already running finishes. */
  clear() {
    this.epoch += 1
  }
}
