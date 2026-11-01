import { z } from 'zod'
import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { activeSession, getCandidates, latestTurn } from '@/lib/server/state'
import { ApproveRequest, type TurnRef } from '@/lib/contracts'
import { ApprovalError, issueApproval } from '@/lib/approval'
import { materialChange } from '@/lib/turns'
import { clonedVoiceUsable, isLibraryVoice } from '@/lib/voices'

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
export async function POST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  const parsed = ApproveRequest.extend({ voice: VoiceAttestation }).safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request', issues: parsed.error.issues.slice(0, 5) }, 400)
  const { voice, ...body } = parsed.data

  // Room approvals must target the caller's own active conversation (wrong-room protection).
  if (body.roomName) {
    const s = activeSession(id.userId)
    if (!s || s.room !== body.roomName || s.conversationId !== body.conversationId) return json({ error: 'wrong_room' }, 403)
  }

  // Voice authorization: library voices are allowed; cloned voices require complete, unexpired consent.
  if (!isLibraryVoice(body.voiceId)) {
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
