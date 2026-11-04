import { z } from 'zod'
import { getIdentity, json, requireAccount, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { getCandidates, latestTurn } from '@/lib/server/state'
import { resolveOwnedSession, ticketFrom } from '@/lib/server/session'
import { ApproveRequest, type TurnRef } from '@/lib/contracts'
import { ApprovalError, issueApproval } from '@/lib/approval'
import { materialChange } from '@/lib/turns'
import { clonedVoiceUsable, isLibraryVoice } from '@/lib/voices'
import { withJsonErrors } from '@/lib/server/route'
import { reserveTtsSpend } from '@/lib/server/spend'
import { workerTtsRef } from '@/lib/spend-refs'

export const dynamic = 'force-dynamic'

/** Cloned-voice consent attestation from the owner's device registry; the server refuses expired/revoked voices. */
const VoiceAttestation = z
  .object({
    voiceId: z.string(),
    region: z.enum(['us', 'eu']),
    consentAt: z.number(),
    providerExpiresAt: z.number().optional(),
    revoked: z.boolean(),
    speakerConsent: z.boolean(),
    rightsConfirmed: z.boolean(),
    biometricTermsAccepted: z.boolean(),
  })
  .optional()

/**
 * Freeze exact text → signed single-use approval. This is the ONLY way text becomes
 * eligible for TTS. Draft text never reaches TTS before this point.
 */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  const raw = await req.json().catch(() => null)
  const parsed = ApproveRequest.extend({ voice: VoiceAttestation, ticket: z.string().max(2000).optional() }).safeParse(raw)
  if (!parsed.success) return json({ error: 'invalid_request', issues: parsed.error.issues.slice(0, 5) }, 400)
  const { voice, ticket, ...body } = parsed.data

  // Room approvals must target the caller's own active conversation (wrong-room protection).
  // B4: verified via the signed session ticket (works on any serverless instance), falling back
  // to this instance's cache and then LiveKit's server-set room metadata — never memory alone.
  if (body.roomName) {
    { const gate = requireAccount(id, 'listening sessions'); if (gate) return gate }
    const s = await resolveOwnedSession(id.userId, body.roomName, ticketFrom(req, { ticket })).catch(() => null)
    if (!s || s.expired || s.conversationId !== body.conversationId || s.generation !== body.generation) return json({ error: 'wrong_room' }, 403)
  }

  // Voice authorization: library voices are allowed; cloned voices require complete, unexpired consent.
  if (!isLibraryVoice(body.voiceId)) {
    { const gate = requireAccount(id, 'cloned voices'); if (gate) return gate }
    if (!voice || voice.voiceId !== body.voiceId) {
      return json({ error: 'voice_not_authorized', message: 'Register this cloned voice with consent details first.' }, 403)
    }
    const u = clonedVoiceUsable(
      { ...voice, id: '', label: '', ownerName: '', recordingLanguage: body.outputLanguage, provenance: 'other-recording', provenanceNote: '', fallbackVoiceId: '', qualityChecked: true },
      env.assemblyRegion(),
    )
    if (!u.ok) return json({ error: 'voice_not_authorized', reason: u.reason }, 403)
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
  try {
    const approval = await issueApproval({ secret: env.approvalSecret(), sub: id.userId, req: body, candidate: { currentTurn } })
    return json({ approval })
  } catch (e) {
    if (e instanceof ApprovalError) return json({ error: e.reason, message: e.message }, 409)
    throw e
  }
}

export const POST = withJsonErrors('approve', handlePOST)
