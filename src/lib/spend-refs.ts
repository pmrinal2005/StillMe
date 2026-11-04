/**
 * Durable reservation references (budget_reservations.ref). Shared by web routes, tests and (by
 * convention) the Python worker, which reports usage for these refs to /api/worker/usage.
 */
export const workerTtsRef = (approvalId: string) => `tts:${approvalId}`
/** Browser-direct STT sessions use a pseudo-room id (never a LiveKit room). */
export const DIRECT_STT_PREFIX = 'sd-'
export const DIRECT_STT_RE = /^sd-[a-f0-9]{24}$/
export const ROOM_RE = /^rv-[a-f0-9]{24}$/

/**
 * A10: minutes to commit for a listening session.
 *  - `measuredMinutes` (from the worker: time the STT stream was actually CONNECTED) wins when known;
 *  - otherwise wall-clock since start, rounded up — a conservative upper bound that the worker's later,
 *    authoritative report corrects downwards.
 * Always clamped to the reservation.
 */
export function sttMinutesToCommit(o: { reserved: number; startedAt: number; now?: number; measuredMinutes?: number | null }): number {
  const reserved = Math.max(0, o.reserved)
  if (o.measuredMinutes !== undefined && o.measuredMinutes !== null && Number.isFinite(o.measuredMinutes)) {
    return Math.min(reserved, Math.max(0, Math.ceil(o.measuredMinutes - 1e-9)))
  }
  const elapsed = Math.max(0, (o.now ?? Date.now()) - o.startedAt)
  return Math.min(reserved, Math.ceil(elapsed / 60_000))
}
