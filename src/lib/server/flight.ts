import 'server-only'
/**
 * C #27 — supersede the in-flight suggestion request.
 *
 * One conversation may have ONE outstanding Groq request (budget rule). The client aborts its previous fetch before it
 * sends a newer one, but the server only learned about that when its own cleanup ran — often AFTER the newer request had
 * already arrived and been refused as `groq_outstanding`, and with the per-turn slot still burned (so the FINAL retry hit
 * `groq_turn_cap`). Now a newer request explicitly supersedes the older one: the older is aborted, its reservations are
 * released AND its per-turn slot refunded, and the newer waits (bounded) for that to finish before it reserves.
 *
 * Process-local on purpose (like the in-memory ledgers): it is a best-effort tidy-up, never an authorization.
 */
export interface Flight {
  key: string
  seq: number
  ac: AbortController
  superseded: boolean
  /** resolves when the PREVIOUS flight for this key has finished its cleanup (or after the bounded wait) */
  ready: Promise<void>
  /** the route calls this in `finally`; frees the slot and wakes the next flight */
  end(): void
  signal: AbortSignal
}

const g = globalThis as unknown as { __rvFlights?: Map<string, { flight: Flight; done: Promise<void> }>; __rvFlightSeq?: number }
const flights = () => (g.__rvFlights ??= new Map())

export const SUPERSEDE_WAIT_MS = 1500

export function startFlight(key: string, parent?: AbortSignal, waitMs = SUPERSEDE_WAIT_MS): Flight {
  const map = flights()
  const prev = map.get(key)
  if (prev) {
    prev.flight.superseded = true
    prev.flight.ac.abort()
  }
  const ac = new AbortController()
  if (parent) {
    if (parent.aborted) ac.abort()
    else parent.addEventListener('abort', () => ac.abort(), { once: true })
  }
  let finish!: () => void
  const done = new Promise<void>((r) => (finish = r))
  const seq = (g.__rvFlightSeq = (g.__rvFlightSeq ?? 0) + 1)
  const ready = prev
    ? Promise.race([prev.done, new Promise<void>((r) => setTimeout(r, waitMs))])
    : Promise.resolve()
  const flight: Flight = {
    key,
    seq,
    ac,
    superseded: false,
    ready,
    signal: ac.signal,
    end() {
      if (map.get(key)?.flight === flight) map.delete(key)
      finish()
    },
  }
  map.set(key, { flight, done })
  return flight
}

export const _flightCount = () => flights().size
