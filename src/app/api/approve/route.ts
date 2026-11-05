import { z } from 'zod'
import { getIdentity, json, requireAccount, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { getCandidates, latestTurn } from '@/lib/server/state'
import { resolveOwnedSession, ticketFrom } from '@/lib/server/session'
import { ApproveRequest, type TurnRef } from '@/lib/contracts'
import { ApprovalError, issueApproval } from '@/lib/approval'
import { materialChange } from '@/lib/turns'
import { authorizeVoice, VoiceRegistryError, voiceStoreFor } from '@/lib/server/voice-registry'
import { withJsonErrors } from '@/lib/server/route'
import { reserveTtsSpend } from '@/lib/server/spend'
import { workerTtsRef } from '@/lib/spend-refs'

export const dynamic = 'force-dynamic'

/**
 * Freeze exact text → signed single-use approval. This is the ONLY way text becomes
 * eligible for TTS. Draft text never reaches TTS before this point.
 */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  const raw = await req.json().catch(() => null)
  const parsed = ApproveRequest.extend({ ticket: z.string().max(2000).optional() }).safeParse(raw)
  if (!parsed.success) return json({ error: 'invalid_request', issues: parsed.error.issues.slice(0, 5) }, 400)
  // B11: any client-supplied `voice` consent attestation is IGNORED (it was self-asserted); the server registry decides.
  const { ticket, ...body } = parsed.data

  // Room approvals must target the caller's own active conversation (wrong-room protection).
  // B4: verified via the signed session ticket (works on any serverless instance), falling back
  // to this instance's cache and then LiveKit's server-set room metadata — never memory alone.
  if (body.roomName) {
    { const gate = requireAccount(id, 'listening sessions'); if (gate) return gate }
    const s = await resolveOwnedSession(id.userId, body.roomName, ticketFrom(req, { ticket })).catch(() => null)
    if (!s || s.expired || s.conversationId !== body.conversationId || s.generation !== body.generation) return json({ error: 'wrong_room' }, 403)
  }

  // B11/B12: voice authorization is decided by the SERVER registry (owner + consent + expiry + revocation + region),
  // never by anything the browser claims. Library voices are open; a cloned voice must be this account's.
  try {
    const va = await authorizeVoice(voiceStoreFor(id.userId), id, body.voiceId, env.assemblyRegion())
    if (!va.ok) {
      if (va.reason === 'account_required') { const gate = requireAccount(id, 'cloned voices'); if (gate) return gate }
      return json({ error: 'voice_not_authorized', reason: va.reason, message: 'This voice is not authorized for your account.' }, 403)
    }
  } catch (e) {
    if (e instanceof VoiceRegistryError) return json({ error: e.code, message: e.message }, e.status)
    throw e
  }

  // Conversation Brake: an AI candidate is only approvable while its partner turn has not materially changed.
  let currentTurn: TurnRef | undefined
  if (body.source) {
    const set = getCandidates(body.source.candidateSetId)
    if (set && set.owner !== id.userId) return json({ error: 'wrong_user' }, 403)
    if (set && set.expiresAt < Date.now()) return json({ error: 'stale_candidate', message: 'These suggestions expired. Review fresh ones.' }, 409)
    const latest = latestTurn(body.source.turn)
    if (latest && set) {
      const reason = latest.ref.transcriptHash === set.turn.transcriptHash ? null : materialChange(set.draftedFrom, latest.text)
      currentTurn = reason ? latest.ref : body.source.turn
    }
  }
  let approval
  try {
    approval = await issueApproval({ secret: env.approvalSecret(), sub: id.userId, req: body, candidate: { currentTurn } })
  } catch (e) {
    if (e instanceof ApprovalError) return json({ error: e.reason, message: e.message }, 409)
    throw e
  }

  // A1: a ROOM approval is spoken by the worker, which used to bypass every budget layer. The money is now
  // reserved HERE (user ∩ project ∩ guest pool ∩ durable), keyed by ref `tts:<approvalId>`. The worker reports
  // the characters it actually synthesized to /api/worker/usage, which settles the row on any instance; a
  // report that never arrives is committed in full by the durable sweep (never left open, never free).
  // Direct approvals are reserved later by /api/speak, so they are not double-counted here.
  if (body.roomName) {
    const spend = await reserveTtsSpend(id, req, approval.chars, workerTtsRef(approval.approvalId))
    if (!spend.ok) return json(spend.body, spend.status)
    if (spend.durableId && spend.legacy) {
      // Legacy store (0003 not applied): no ref column, so the worker cannot settle by ref. Commit the full
      // approved length now — conservative (over-counts a cancelled utterance, never under-counts).
      await spend.commit(approval.chars)
    } else {
      spend.commitMemoryOnly() // memory ledgers: full approved length; durable row awaits the worker's report
    }
  }
  return json({ approval })
}

export const POST = withJsonErrors('approve', handlePOST)
