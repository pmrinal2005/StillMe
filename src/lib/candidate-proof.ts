/**
 * C #31 — stateless, signed candidate proof + FAIL-CLOSED "has the conversation changed?" check.
 *
 * Before: /api/suggest remembered each candidate set in PROCESS MEMORY and /api/approve consulted that memory. On
 * serverless the approve request usually lands on a different instance: the set was "unknown", the brake was skipped
 * and a stale AI candidate was approved (fail-OPEN). Now the suggest route signs an HMAC proof over everything the
 * approval check needs, the browser carries it, and ANY instance can verify it with the shared approval secret.
 *
 * The check is fail-closed: a candidate-sourced approval without a valid proof, or whose conversation state cannot be
 * verified, is refused (the owner can still type or edit the words themselves — that path needs no proof).
 */
import { hmacSha256Hex, sha256Hex, timingSafeEqualHex } from './hash'
import { isSubstantiveTurn, materialChange } from './turns'
import type { ApproveRequest, TurnRef } from './contracts'

export interface CandidateProofPayload {
  v: 1
  /** authenticated owner (user id) the set was drafted for */
  owner: string
  set: string
  turn: TurnRef
  /** sha256 of the exact partner text the set was drafted from */
  from: string
  /** candidateId -> sha256 of the exact candidate text (lets the server tell edited from unedited honestly) */
  cands: Record<string, string>
  /** expiry (ms epoch) */
  exp: number
}

const PREFIX = 'revoice-candidate-proof-v1.'

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function b64urlDecode(s: string): string {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export async function signCandidateProof(secret: string, payload: CandidateProofPayload): Promise<string> {
  const body = b64urlEncode(JSON.stringify(payload))
  return `${body}.${await hmacSha256Hex(secret, PREFIX + body)}`
}

export type ProofFailure = 'malformed' | 'bad_signature' | 'expired'

export async function verifyCandidateProof(
  secret: string,
  proof: string,
  now = Date.now(),
): Promise<{ ok: true; payload: CandidateProofPayload } | { ok: false; reason: ProofFailure }> {
  const dot = proof.lastIndexOf('.')
  if (dot <= 0) return { ok: false, reason: 'malformed' }
  const body = proof.slice(0, dot)
  const sig = proof.slice(dot + 1)
  if (!/^[a-f0-9]{64}$/.test(sig)) return { ok: false, reason: 'malformed' }
  if (!timingSafeEqualHex(await hmacSha256Hex(secret, PREFIX + body), sig)) return { ok: false, reason: 'bad_signature' }
  let payload: CandidateProofPayload
  try {
    payload = JSON.parse(b64urlDecode(body)) as CandidateProofPayload
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (payload?.v !== 1 || typeof payload.owner !== 'string' || typeof payload.set !== 'string' || !payload.turn || !payload.cands || typeof payload.exp !== 'number') {
    return { ok: false, reason: 'malformed' }
  }
  if (payload.exp < now) return { ok: false, reason: 'expired' }
  return { ok: true, payload }
}

export type SourceVerdict =
  | { ok: true; turn: TurnRef }
  | { ok: false; status: 403 | 409; error: 'stale_candidate' | 'wrong_user' | 'altered_text'; reason: string; message: string }

const deny = (status: 403 | 409, error: 'stale_candidate' | 'wrong_user' | 'altered_text', reason: string, message: string): SourceVerdict => ({ ok: false, status, error, reason, message })

const sameTurn = (a: TurnRef, b: TurnRef) =>
  a.conversationId === b.conversationId && a.generation === b.generation && a.turnId === b.turnId && a.revision === b.revision && a.transcriptHash === b.transcriptHash

/**
 * Decide whether an approval that claims an AI candidate as its source may proceed.
 * `serverLatest` is an OPTIONAL extra signal (this instance's memory of the newest partner revision); it can only make
 * the verdict stricter, never more lenient.
 */
export async function evaluateCandidateSource(opts: {
  secret: string
  owner: string
  body: Pick<ApproveRequest, 'textHash' | 'conversationId' | 'generation'>
  source: NonNullable<ApproveRequest['source']>
  serverLatest?: { ref: TurnRef; text: string }
  now?: number
}): Promise<SourceVerdict> {
  const { secret, owner, body, source } = opts
  const now = opts.now ?? Date.now()
  if (!source.proof) return deny(409, 'stale_candidate', 'proof_missing', 'These suggestions cannot be verified. Review fresh ones or write your own words.')
  const v = await verifyCandidateProof(secret, source.proof, now)
  if (!v.ok) {
    return deny(409, 'stale_candidate', v.reason === 'expired' ? 'expired' : 'invalid_proof', v.reason === 'expired' ? 'These suggestions expired. Review fresh ones.' : 'These suggestions cannot be verified. Review fresh ones.')
  }
  const p = v.payload
  if (p.owner !== owner) return deny(403, 'wrong_user', 'wrong_user', 'These suggestions belong to another account.')
  if (p.set !== source.candidateSetId || !sameTurn(p.turn, source.turn)) return deny(409, 'stale_candidate', 'invalid_proof', 'These suggestions do not match the conversation turn they claim.')
  if (p.turn.conversationId !== body.conversationId || p.turn.generation !== body.generation) {
    return deny(409, 'stale_candidate', 'conversation_changed', 'The conversation changed after this suggestion was drafted.')
  }
  const candHash = p.cands[source.candidateId]
  if (!candHash) return deny(409, 'stale_candidate', 'invalid_proof', 'That suggestion is not part of the verified set.')
  if (!source.edited && !timingSafeEqualHex(candHash, body.textHash)) return deny(409, 'altered_text', 'altered_text', 'The text differs from the suggestion it claims to be unedited.')

  // ---- fail-closed conversation check (needs the partner text the set was drafted from AND the newest turn)
  if (!source.draftedFrom || !timingSafeEqualHex(await sha256Hex(source.draftedFrom), p.from)) {
    return deny(409, 'stale_candidate', 'conversation_unverified', 'Could not verify what the suggestion answers. Review fresh ones.')
  }
  const cur = source.current
  if (!cur || !timingSafeEqualHex(await sha256Hex(cur.text), cur.turn.transcriptHash)) {
    return deny(409, 'stale_candidate', 'conversation_unverified', 'Could not verify the latest conversation state. Review fresh suggestions.')
  }
  if (cur.turn.conversationId !== p.turn.conversationId || cur.turn.generation !== p.turn.generation) {
    return deny(409, 'stale_candidate', 'conversation_changed', 'The conversation changed after this suggestion was drafted.')
  }
  const stale = (c: { ref: TurnRef; text: string }): string | null => {
    if (c.ref.turnId < p.turn.turnId) return 'new_turn' // a newest turn older than the candidate's own cannot be right
    if (c.ref.turnId > p.turn.turnId) return isSubstantiveTurn(c.text) ? 'new_turn' : null
    if (c.ref.transcriptHash === p.turn.transcriptHash) return null
    return materialChange(source.draftedFrom!, c.text)
  }
  const reported = stale({ ref: cur.turn, text: cur.text })
  if (reported) return deny(409, 'stale_candidate', reported, 'The conversation changed after this suggestion was drafted.')
  const mem = opts.serverLatest
  if (mem && mem.ref.conversationId === p.turn.conversationId && mem.ref.generation === p.turn.generation) {
    const m = stale(mem)
    if (m) return deny(409, 'stale_candidate', m, 'The conversation changed after this suggestion was drafted.')
  }
  return { ok: true, turn: source.turn }
}
