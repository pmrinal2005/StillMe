/**
 * F: generation arithmetic (shared by the route and the tests).
 * A generation only ever goes UP, by exactly one, from the highest value any trustworthy source has seen.
 */
export const MAX_GENERATION = 10_000

export function nextGeneration(ticketGeneration: number, roomGeneration: number): number {
  const base = Math.max(0, Math.floor(ticketGeneration) || 0, Math.floor(roomGeneration) || 0)
  return Math.min(MAX_GENERATION, base + 1)
}

/** Client side: accept a server-issued generation only if it moves forward (never back, never a huge jump). */
export function acceptGeneration(current: number, issued: number): boolean {
  return Number.isInteger(issued) && issued > current && issued <= current + 50
}
