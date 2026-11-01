import { cookies } from 'next/headers'
import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { forgetUser } from '@/lib/server/state'

export const dynamic = 'force-dynamic'

/**
 * Deletes server-held state for this user. Supabase rows cascade from auth.users deletion
 * (see migrations). Application deletion does NOT delete data held by third parties:
 * cloned voices must be deleted in the AssemblyAI dashboard; Groq/LiveKit retention per their policies.
 */
export async function POST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  forgetUser(id.userId)
  if (id.kind === 'local-demo') (await cookies()).delete('rv_demo')
  return json({
    ok: true,
    thirdPartyActions: [
      'Delete any cloned voice in the AssemblyAI dashboard (Text-to-speech → Voices).',
      'Groq: verify Zero Data Retention settings; exception logs may be kept up to 30 days.',
      'LiveKit: rooms are ephemeral; no recordings are made by ReVOICE.',
    ],
  })
}
