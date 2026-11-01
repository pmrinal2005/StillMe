import 'server-only'
import { BudgetLedger } from '../budget'
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
  phoneCodes: Map<string, { userId: string; room: string; expiresAt: number }>
  /** month key → inbound phone minutes used (application cap, of the 50 included) */
  phoneMinutes: Map<string, number>
  reconciliations: { at: number; provider: string; periodStart: string; periodEnd: string; providerReportedUsd: number | null; note: string }[]
}
export interface ActiveSession { room: string; conversationId: string; mode: string; startedAt: number; maxMinutes: number; generation: number }
const g = globalThis as unknown as { __rv?: RvState }
if (!g.__rv) {
  g.__rv = { ledgers: new Map(), projectLedger: new BudgetLedger(), replay: new MemoryReplayStore(), turns: new Map(), candidates: new Map(), sessions: new Map(), phoneCodes: new Map(), phoneMinutes: new Map(), reconciliations: [] }
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
  g.__rv!.ledgers.delete(userId)
  for (const [k, c] of g.__rv!.candidates) if (c.owner === userId) g.__rv!.candidates.delete(k)
}
