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
}
const g = globalThis as unknown as { __rv?: RvState }
if (!g.__rv) {
  g.__rv = { ledgers: new Map(), projectLedger: new BudgetLedger(), replay: new MemoryReplayStore(), turns: new Map(), candidates: new Map() }
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

export function forgetUser(userId: string) {
  g.__rv!.ledgers.delete(userId)
  for (const [k, c] of g.__rv!.candidates) if (c.owner === userId) g.__rv!.candidates.delete(k)
}
