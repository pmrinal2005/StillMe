import { z } from 'zod'
import { getIdentity, json, requireAccount, unauthorized } from '@/lib/server/auth'
import { audit } from '@/lib/server/durable'
import { revokeClonedVoice, VoiceRegistryError, voiceStoreFor } from '@/lib/server/voice-registry'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

const Body = z.object({ voiceId: z.string().min(1).max(128) })

/** B11: revocation is recorded server-side, so no device (and no stale browser copy) can keep using the clone. */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  { const gate = requireAccount(id, 'cloned voices'); if (gate) return gate }
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request' }, 400)
  try {
    const v = await revokeClonedVoice(voiceStoreFor(id.userId), id.userId, parsed.data.voiceId)
    void audit(id.userId, 'voice_revoked', v.id)
    return json({ ok: true, voice: v, thirdPartyActions: ['Delete the clone in the AssemblyAI dashboard (Text-to-speech → Voices) to remove it from the provider.'] })
  } catch (e) {
    if (e instanceof VoiceRegistryError) return json({ error: e.code }, e.status)
    throw e
  }
}

export const POST = withJsonErrors('voices/revoke', handlePOST)
