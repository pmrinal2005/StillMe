import 'server-only'

/**
 * Tiny per-instance sliding-window limiter (memory). Used as a cheap first line of defence for
 * probing-prone routes (voice registration, invite minting). Durable, cross-instance counting for the
 * phone pairing brute-force guard lives in phone-guard.ts.
 */
interface Win { hits: number[] }
const g = globalThis as unknown as { __rvRate?: Map<string, Win> }
const store = () => (g.__rvRate ??= new Map())

/** Records one hit; returns false (and does NOT record) when `limit` hits already happened in `windowMs`. */
export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const m = store()
  const w = m.get(key) ?? { hits: [] }
  w.hits = w.hits.filter((t) => now - t < windowMs)
  if (w.hits.length >= limit) {
    m.set(key, w)
    return false
  }
  w.hits.push(now)
  m.set(key, w)
  if (m.size > 5000) for (const [k, v] of m) if (!v.hits.some((t) => now - t < windowMs)) m.delete(k)
  return true
}

/** Hits recorded in the window (no side effects). */
export function count(key: string, windowMs: number, now = Date.now()): number {
  return (store().get(key)?.hits ?? []).filter((t) => now - t < windowMs).length
}

/** Records a hit unconditionally (for failure counters) and returns the count in the window. */
export function hit(key: string, windowMs: number, now = Date.now()): number {
  const m = store()
  const w = m.get(key) ?? { hits: [] }
  w.hits = w.hits.filter((t) => now - t < windowMs)
  w.hits.push(now)
  m.set(key, w)
  return w.hits.length
}

export function reset(prefix = '') {
  const m = store()
  for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k)
}
