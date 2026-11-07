/**
 * Partner-input turn tracking + "Conversation Brake".
 *
 * AssemblyAI re-transcribes the full turn on every Turn message, so each message
 * SUPERSEDES the previous one: we replace, never append. Every replacement bumps a
 * revision counter, and candidates are bound to (turnId, revision, transcriptHash).
 *
 * The brake decides whether a revision is a *material* change that must cancel
 * drafts and pending approvals (negation added, number/date changed, topic change).
 */
import type { TurnRef } from './contracts'
import { sha256Hex } from './hash'

export interface PartnerTurn {
  turnId: number
  revision: number
  text: string
  endOfTurn: boolean
  hash: string
  updatedAt: number
  /** C #30: the revision number the SOURCE (worker) stamped on the last applied message, when it provides one. */
  srcRevision?: number
}

const NEGATIONS = /\b(not|no|never|don'?t|doesn'?t|didn'?t|won'?t|can'?t|cannot|isn'?t|aren'?t|wasn'?t|shouldn'?t|wouldn'?t|actually|instead|rather|wait|cancel|nevermind|never mind|scratch that)\b/gi
const NUMBERISH = /\b(\d+(?:[.:/]\d+)*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|yesterday|morning|afternoon|evening|january|february|march|april|may|june|july|august|september|october|november|december|am|pm)\b/gi

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean)
}

/** A turn long enough that a reply drafted before it could not have accounted for it (shared by client + server checks). */
export function isSubstantiveTurn(text: string): boolean {
  return tokens(text).length >= 3
}

const NUMBER_WORDS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12' }

/**
 * AssemblyAI's partial transcripts say "seven o'clock" and the formatted final says "7 o'clock" (or "7:00"). That is the SAME
 * number, not a changed one: without this the Conversation Brake fired on almost every formatted final and greyed out the
 * suggestion cards. Number words become digits and a trailing ":00" is dropped before comparing.
 */
function normalizeNumbers(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (w) => NUMBER_WORDS[w] ?? w)
    .replace(/\b(\d{1,2}):00\b/g, '$1')
}

function matches(re: RegExp, s: string): string[] {
  return (normalizeNumbers(s).match(re) ?? []).map((m) => m.replace(/\s+/g, ' '))
}

function multiset(a: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const x of a) m.set(x, (m.get(x) ?? 0) + 1)
  return m
}

function sameMultiset(a: string[], b: string[]): boolean {
  const ma = multiset(a)
  const mb = multiset(b)
  if (ma.size !== mb.size) return false
  for (const [k, v] of ma) if (mb.get(k) !== v) return false
  return true
}

export type BrakeReason = 'negation' | 'number_or_date' | 'topic_change' | 'new_turn'

/**
 * Returns a reason if `next` materially changes the meaning relative to `prev`
 * (the revision a candidate/approval was drafted from), otherwise null.
 * Pure extension of the same sentence (more words appended, same facts) is NOT material.
 */
export function materialChange(prev: string, next: string): BrakeReason | null {
  if (prev === next) return null
  const negPrev = matches(NEGATIONS, prev)
  const negNext = matches(NEGATIONS, next)
  if (!sameMultiset(negPrev, negNext)) return 'negation'
  const numPrev = matches(NUMBERISH, prev)
  const numNext = matches(NUMBERISH, next)
  // Numbers/dates removed or altered is material; new ones appended is also material
  // because a reply drafted before them could not have accounted for them.
  if (!sameMultiset(numPrev, numNext)) return 'number_or_date'
  const tp = tokens(prev)
  const tn = tokens(next)
  if (tp.length >= 4) {
    const setN = new Set(tn)
    const kept = tp.filter((t) => setN.has(t)).length
    if (kept / tp.length < 0.6) return 'topic_change'
  }
  // Appended content that adds a question after a statement changes what's expected of the user.
  const qPrev = (prev.match(/\?/g) ?? []).length
  const qNext = (next.match(/\?/g) ?? []).length
  if (qNext > qPrev && tn.length - tp.length >= 3) return 'topic_change'
  return null
}

export class TurnTracker {
  private turns = new Map<number, PartnerTurn>()
  private order: number[] = []
  constructor(public conversationId: string, public generation = 0, private maxTurns = 12) {}

  /** Apply a Turn message (partial or final). Replaces any earlier revision of the same turn. */
  async apply(msg: { turnId: number; text: string; endOfTurn: boolean; revision?: number }, now = Date.now()): Promise<{ turn: PartnerTurn; changed: boolean }> {
    const existing = this.turns.get(msg.turnId)
    // C #30 revision guard: a message the source numbered at or below what we already applied is a late/duplicate delivery
    // (reordered data packets, a retransmit) and must never overwrite a newer revision. The FINAL of a turn is exempt from
    // being treated as a duplicate only if it carries a higher revision, which the worker guarantees.
    if (existing && msg.revision !== undefined && existing.srcRevision !== undefined && msg.revision <= existing.srcRevision) {
      return { turn: existing, changed: false }
    }
    if (existing && existing.text === msg.text && existing.endOfTurn === msg.endOfTurn) {
      if (msg.revision !== undefined && (existing.srcRevision === undefined || msg.revision > existing.srcRevision)) existing.srcRevision = msg.revision
      return { turn: existing, changed: false }
    }
    // A finalized turn is authoritative; ignore late partials for it.
    if (existing?.endOfTurn && !msg.endOfTurn) return { turn: existing, changed: false }
    const turn: PartnerTurn = {
      turnId: msg.turnId,
      revision: existing ? existing.revision + 1 : 0,
      text: msg.text,
      endOfTurn: msg.endOfTurn,
      hash: await sha256Hex(msg.text),
      updatedAt: now,
      srcRevision: msg.revision,
    }
    if (!existing) {
      this.order.push(msg.turnId)
      while (this.order.length > this.maxTurns) this.turns.delete(this.order.shift()!)
    }
    this.turns.set(msg.turnId, turn)
    return { turn, changed: true }
  }

  get(turnId: number): PartnerTurn | undefined {
    return this.turns.get(turnId)
  }

  latest(): PartnerTurn | undefined {
    const id = this.order[this.order.length - 1]
    return id === undefined ? undefined : this.turns.get(id)
  }

  all(): PartnerTurn[] {
    return this.order.map((id) => this.turns.get(id)!).filter(Boolean)
  }

  ref(turn: PartnerTurn): TurnRef {
    return {
      conversationId: this.conversationId,
      generation: this.generation,
      turnId: turn.turnId,
      revision: turn.revision,
      transcriptHash: turn.hash,
    }
  }

  /** F: adopt the SERVER-issued generation after a reconnect (drops every turn: all earlier candidates are stale). */
  setGeneration(generation: number) {
    this.generation = generation
    this.turns.clear()
    this.order = []
  }

  /** Room reconnect / new session: invalidates every outstanding candidate and approval. */
  bumpGeneration() {
    this.generation += 1
    this.turns.clear()
    this.order = []
  }

  /**
   * Is a candidate/approval drafted from `ref` (with source text `draftedFrom`) still valid?
   * Returns null if valid, or the brake reason if it must be invalidated.
   */
  staleness(ref: TurnRef, draftedFrom: string): BrakeReason | null {
    if (ref.conversationId !== this.conversationId || ref.generation !== this.generation) return 'new_turn'
    const cur = this.turns.get(ref.turnId)
    if (!cur) return 'new_turn'
    const latest = this.latest()
    // A newer partner turn that is substantive means the user's context has moved on.
    if (latest && latest.turnId !== ref.turnId && isSubstantiveTurn(latest.text)) return 'new_turn'
    if (cur.hash === ref.transcriptHash) return null
    return materialChange(draftedFrom, cur.text)
  }
}
