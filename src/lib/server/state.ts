import 'server-only'
import { BudgetLedger, NETWORK_POOL_LIMITS, PROJECT_LIMITS } from '../budget'
import { MemoryReplayStore } from '../approval'
import type { TurnRef } from '../contracts'

/**
 * Process-local singletons. Good for a single-instance prototype (`next start`).
 * On serverless/multi-instance hosting, back these with Supabase tables
 * (budget_reservations, approval_uses) — see supabase/migrations/0001_init.sql.
 * Live transcripts / candidates are memory-only by design (no persistence).
 */
interface RvState {
  ledgers: Map<string, BudgetLedger>
  projectLedger: BudgetLedger
  replay: MemoryReplayStore
  /** `${conv}:${gen}:${turnId}` → latest server-seen revision of a partner turn */
  turns: Map<string, { ref: TurnRef; text: string; at: number }>
  /** candidateSetId → binding + the exact partner text it was drafted from */
  candidates: Map<string, { owner: string; turn: TurnRef; draftedFrom: string; expiresAt: number; texts: Record<string, string> }>
  /** userId → the single active conversation (one active conversation per user) */
  sessions: Map<string, ActiveSession>
  /** phone pairing code → binding to an active owner session (expiring, single use) */
  phoneCodes: Map<string, { userId: string; room: string; expiresAt: number; attempts: number }>
  /** `${room}:${identity}` → minutes reserved for an in-progress call (settled by /api/phone/usage) */
  phoneReservations: Map<string, { minutes: number; month: string; userId: string; at: number }>
  /** month key → inbound phone minutes used (application cap, of the 50 included) */
  phoneMinutes: Map<string, number>
  /** B3: rooms whose STT reservation was already settled on this instance (idempotent end). */
  settledRooms: Map<string, number>
  reconciliations: { at: number; provider: string; periodStart: string; periodEnd: string; providerReportedUsd: number | null; note: string }[]
}
/**
 * Per-instance CACHE of sessions started on THIS instance. Since B4 it is never the source of truth:
 * session-scoped routes authorize with the signed session ticket (src/lib/session-ticket.ts) and
 * fall back to LiveKit room metadata. The cache only records which STT minutes this instance's
 * in-memory ledgers reserved, so they can be refunded exactly once (B3).
 */
export interface ActiveSession {
  room: string
  conversationId: string
  mode: string
  startedAt: number
  maxMinutes: number
  generation: number
  /** B3: minutes reserved on this instance's user + project ledgers, the UTC day, and the durable reservation. */
  sttMinutes: number
  sttDay: string
  sttReservationId: string | null
}
const g = globalThis as unknown as { __rv?: RvState }
if (g.__rv && !g.__rv.settledRooms) g.__rv.settledRooms = new Map() // hot-reload safety
if (!g.__rv) {
  g.__rv = { ledgers: new Map(), projectLedger: new BudgetLedger(PROJECT_LIMITS), replay: new MemoryReplayStore(), turns: new Map(), candidates: new Map(), sessions: new Map(), phoneCodes: new Map(), phoneReservations: new Map(), phoneMinutes: new Map(), settledRooms: new Map(), reconciliations: [] }
}

/** Per-user ledger AND a project-wide ledger: both must allow a request (intersecting limits). */
export function ledgerFor(userId: string): BudgetLedger {
  let l = g.__rv!.ledgers.get(userId)
  if (!l) {
    l = new BudgetLedger()
    g.__rv!.ledgers.set(userId, l)
  }
  return l
}
export const projectLedger = () => g.__rv!.projectLedger
/** One shared pool PER NETWORK (key = HMAC of the client IP), so clearing cookies cannot mint unlimited device budget. */
const np = globalThis as unknown as { __rvNetPools?: Map<string, BudgetLedger> }
export const networkPoolLedger = (key: string): BudgetLedger => {
  const m = (np.__rvNetPools ??= new Map())
  let l = m.get(key)
  if (!l) {
    if (m.size >= 2000) m.delete(m.keys().next().value as string) // bounded memory on a long-lived instance
    l = new BudgetLedger(NETWORK_POOL_LIMITS)
    m.set(key, l)
  }
  return l
}
export const replayStore = () => g.__rv!.replay

export const turnKey = (r: Pick<TurnRef, 'conversationId' | 'generation' | 'turnId'>) => `${r.conversationId}:${r.generation}:${r.turnId}`

export function recordTurn(ref: TurnRef, text: string) {
  const m = g.__rv!.turns
  const k = turnKey(ref)
  const prev = m.get(k)
  if (!prev || prev.ref.revision <= ref.revision) m.set(k, { ref, text, at: Date.now() })
  if (m.size > 2000) for (const [key, v] of m) if (Date.now() - v.at > 3_600_000) m.delete(key)
}
export const latestTurn = (r: Pick<TurnRef, 'conversationId' | 'generation' | 'turnId'>) => g.__rv!.turns.get(turnKey(r))

export function recordCandidates(id: string, v: RvState['candidates'] extends Map<string, infer V> ? V : never) {
  const m = g.__rv!.candidates
  m.set(id, v)
  const now = Date.now()
  if (m.size > 1000) for (const [k, c] of m) if (c.expiresAt < now) m.delete(k)
}
export const getCandidates = (id: string) => g.__rv!.candidates.get(id)

export const rv = () => g.__rv!

/** Returns the caller's active session if it has not exceeded its bounded duration. */
export function activeSession(userId: string, now = Date.now()): ActiveSession | undefined {
  const s = g.__rv!.sessions.get(userId)
  if (!s) return undefined
  if (now - s.startedAt > (s.maxMinutes + 1) * 60_000) {
    g.__rv!.sessions.delete(userId)
    return undefined
  }
  return s
}
export function sessionByRoom(room: string): { userId: string; s: ActiveSession } | undefined {
  for (const [userId, s] of g.__rv!.sessions) if (s.room === room) return { userId, s }
  return undefined
}
export const monthKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 7)

export function forgetUser(userId: string) {
  g.__rv!.sessions.delete(userId)
  for (const [k, c] of g.__rv!.phoneCodes) if (c.userId === userId) g.__rv!.phoneCodes.delete(k)
  for (const [k, r] of g.__rv!.phoneReservations) if (r.userId === userId) g.__rv!.phoneReservations.delete(k)
  g.__rv!.ledgers.delete(userId)
  for (const [k, c] of g.__rv!.candidates) if (c.owner === userId) g.__rv!.candidates.delete(k)
}

/** Month usage = settled minutes + outstanding call reservations (both count against the 40-min cap). */
export function phoneMonthUsed(now = Date.now()): number {
  const m = monthKey(now)
  let used = g.__rv!.phoneMinutes.get(m) ?? 0
  for (const [k, r] of g.__rv!.phoneReservations) {
    // Reservations for calls that never reported usage expire after their max length + slack (counted as fully used).
    if (now - r.at > 20 * 60_000) {
      g.__rv!.phoneMinutes.set(r.month, (g.__rv!.phoneMinutes.get(r.month) ?? 0) + r.minutes)
      g.__rv!.phoneReservations.delete(k)
      if (r.month === m) used += r.minutes
      continue
    }
    if (r.month === m) used += r.minutes
  }
  return used
}

/**
 * D #46 — month usage that survives serverless instances.
 *
 * Bug: `phoneMonthUsed` only knew THIS instance's memory, so on Vercel every cold instance started the month at 0 and the
 * 40-minute cap (10 minutes of headroom under LiveKit's 50 included) could be exceeded several times over.
 * Now the durable total (Postgres `phone_month_usage`) is read first and the instance figure is used only as a FLOOR
 * (max of the two), so it can never under-count: the instance may know about a call the database has not seen yet.
 */
export async function phoneMonthUsedDurable(
  now = Date.now(),
  read: (month: string) => Promise<number | null> = async (m) => (await import('./durable')).phoneMonthMinutesDurable(m),
): Promise<number> {
  const local = phoneMonthUsed(now)
  const durable = await read(monthKey(now)).catch(() => null)
  return durable === null ? local : Math.max(local, durable)
}

/**
 * B3: settle a session's listening reservation exactly once per instance.
 * - The in-memory ledgers are refunded only if THIS instance made the reservation (cache hit).
 * - The durable reservation (if any) is settled by the caller via settleDurable — Postgres makes
 *   that idempotent (`where status = 'reserved'`).
 * Returns false if this room was already settled here.
 */
export function settleLocalStt(
  userId: string,
  room: string,
  usedMinutes: number,
  now = Date.now(),
  /**
   * Quota-lockout fix: on serverless hosting the instance that settles a session is usually NOT the one that reserved it, so
   * the cache lookup below misses and the reservation used to stay charged in the reserving instance's ledger until the next
   * cold start ("Could not start listening (stt daily minutes)" after two or three tries). A valid signed session ticket
   * carries what was reserved, so this instance can still refund its own ledgers (clamped at zero, once per room).
   */
  fromTicket?: { sttMinutes: number; sttDay: string },
): boolean {
  const st = g.__rv!
  for (const [k, t] of st.settledRooms) if (now - t > 86_400_000) st.settledRooms.delete(k)
  if (st.settledRooms.has(room)) return false
  st.settledRooms.set(room, now)
  const s = st.sessions.get(userId)
  if (s && s.room === room) {
    ledgerFor(userId).releaseSttMinutes(s.sttMinutes, usedMinutes, s.sttDay, now)
    st.projectLedger.releaseSttMinutes(s.sttMinutes, usedMinutes, s.sttDay, now)
    st.sessions.delete(userId)
  } else if (fromTicket && fromTicket.sttMinutes > 0) {
    ledgerFor(userId).releaseSttMinutes(fromTicket.sttMinutes, usedMinutes, fromTicket.sttDay, now)
    st.projectLedger.releaseSttMinutes(fromTicket.sttMinutes, usedMinutes, fromTicket.sttDay, now)
  }
  return true
}

/** Operator tool: clear every in-memory listening-minute reservation on THIS instance (quota reset). */
export function resetSttLedgers(now = Date.now()): { cleared: number } {
  const st = g.__rv!
  let cleared = 0
  for (const l of st.ledgers.values()) cleared += l.resetStt(now)
  cleared += st.projectLedger.resetStt(now)
  for (const l of (globalThis as unknown as { __rvNetPools?: Map<string, import('../budget').BudgetLedger> }).__rvNetPools?.values() ?? []) cleared += l.resetStt(now)
  st.sessions.clear()
  st.settledRooms.clear()
  return { cleared }
}
