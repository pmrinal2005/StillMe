/**
 * Approval protocol — the permission boundary of ReVOICE.
 *
 * A detected gap is not consent. A plausible reply is not the user's intention.
 * Only an approval signed here, bound to an authenticated user, an exact text hash,
 * a conversation/room/generation, a voice and a short expiry, may cause speech.
 *
 * Verification rejects: altered text, stale generation, replay, expiry,
 * wrong room, wrong participant, wrong voice, and stale AI candidates.
 *
 * Canonical signing string must match worker/revoice_worker/approval.py exactly.
 */
import type { Approval, ApproveRequest, TurnRef } from './contracts'
import { codePoints, hmacSha256Hex, randomId, sha256Hex, timingSafeEqualHex } from './hash'

export const APPROVAL_TTL_MS = 60_000 // approval must be used within a minute

export function canonicalApprovalString(a: Omit<Approval, 'sig'>): string {
  return [
    `v=${a.v}`,
    `approvalId=${a.approvalId}`,
    `playbackAttemptId=${a.playbackAttemptId}`,
    `sub=${a.sub}`,
    `conversationId=${a.conversationId}`,
    `roomName=${a.roomName ?? ''}`,
    `generation=${a.generation}`,
    `textHash=${a.textHash}`,
    `voiceId=${a.voiceId}`,
    `outputLanguage=${a.outputLanguage}`,
    `chars=${a.chars}`,
    `iat=${a.iat}`,
    `exp=${a.exp}`,
  ].join('\n')
}

export type RejectReason =
  | 'altered_text'
  | 'bad_signature'
  | 'expired'
  | 'replayed'
  | 'wrong_user'
  | 'wrong_room'
  | 'stale_generation'
  | 'wrong_voice'
  | 'stale_candidate'
  | 'voice_not_authorized'
  | 'malformed'

export class ApprovalError extends Error {
  constructor(public reason: RejectReason, message?: string) {
    super(message ?? reason)
  }
}

export interface CandidateBinding {
  /** Latest known revision of the turn the candidate answered, if the server still tracks it. */
  currentTurn?: TurnRef
}

export async function issueApproval(opts: {
  secret: string
  sub: string
  req: ApproveRequest
  now?: number
  candidate?: CandidateBinding
}): Promise<Approval> {
  const { secret, sub, req } = opts
  const now = opts.now ?? Date.now()
  const actualHash = await sha256Hex(req.text)
  if (!timingSafeEqualHex(actualHash, req.textHash)) {
    throw new ApprovalError('altered_text', 'The displayed text does not match the approved hash.')
  }
  // An approved AI candidate is only valid while its partner turn has not materially changed.
  if (req.source && opts.candidate?.currentTurn) {
    const cur = opts.candidate.currentTurn
    const src = req.source.turn
    if (
      cur.conversationId !== src.conversationId ||
      cur.generation !== src.generation ||
      cur.turnId !== src.turnId ||
      cur.transcriptHash !== src.transcriptHash
    ) {
      throw new ApprovalError('stale_candidate', 'The conversation changed after this suggestion was drafted.')
    }
  }
  const unsigned: Omit<Approval, 'sig'> = {
    v: 1,
    approvalId: randomId(16),
    playbackAttemptId: randomId(16),
    sub,
    conversationId: req.conversationId,
    roomName: req.roomName ?? null,
    generation: req.generation,
    textHash: actualHash,
    voiceId: req.voiceId,
    outputLanguage: req.outputLanguage,
    chars: codePoints(req.text),
    iat: now,
    exp: now + APPROVAL_TTL_MS,
  }
  const sig = await hmacSha256Hex(secret, canonicalApprovalString(unsigned))
  return { ...unsigned, sig }
}

/** Single-use store for approval ids. Replace with a durable store (Supabase) for multi-instance deploys. */
export interface ReplayStore {
  /** Returns true if the id was newly consumed, false if it was already used. */
  consume(approvalId: string, expiresAt: number): Promise<boolean>
}

export class MemoryReplayStore implements ReplayStore {
  private used = new Map<string, number>()
  async consume(approvalId: string, expiresAt: number): Promise<boolean> {
    const now = Date.now()
    for (const [id, exp] of this.used) if (exp + 60_000 < now) this.used.delete(id)
    if (this.used.has(approvalId)) return false
    this.used.set(approvalId, expiresAt)
    return true
  }
}

export async function verifyApproval(opts: {
  secret: string
  approval: Approval
  text: string
  expect: { sub: string; conversationId?: string; roomName?: string | null; generation?: number; voiceId?: string }
  replay: ReplayStore
  now?: number
}): Promise<Approval> {
  const { secret, approval: a, text, expect, replay } = opts
  const now = opts.now ?? Date.now()
  const { sig, ...unsigned } = a
  const expected = await hmacSha256Hex(secret, canonicalApprovalString(unsigned))
  if (!timingSafeEqualHex(expected, sig)) throw new ApprovalError('bad_signature')
  if (!timingSafeEqualHex(await sha256Hex(text), a.textHash)) throw new ApprovalError('altered_text')
  if (now > a.exp) throw new ApprovalError('expired')
  if (a.sub !== expect.sub) throw new ApprovalError('wrong_user')
  if (expect.conversationId !== undefined && a.conversationId !== expect.conversationId) throw new ApprovalError('wrong_room')
  if (expect.roomName !== undefined && (a.roomName ?? null) !== (expect.roomName ?? null)) throw new ApprovalError('wrong_room')
  if (expect.generation !== undefined && a.generation !== expect.generation) throw new ApprovalError('stale_generation')
  if (expect.voiceId !== undefined && a.voiceId !== expect.voiceId) throw new ApprovalError('wrong_voice')
  // Consume last so a rejected approval is not burned by a failed check above.
  if (!(await replay.consume(a.approvalId, a.exp))) throw new ApprovalError('replayed')
  return a
}
