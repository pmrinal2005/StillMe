import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { ledgerFor } from '@/lib/server/state'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

/**
 * Server-side export. Most personal data (phrase boards, style card, voice registry) lives
 * on-device in IndexedDB and is exported client-side; Supabase rows are exported via RLS by the
 * client SDK. This returns what the app server holds: content-free usage counters only.
 */
async function handleGET(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  return json({
    exportedAt: new Date().toISOString(),
    identity: { userId: id.userId, kind: id.kind },
    usage: ledgerFor(id.userId).snapshot(),
    note: 'ReVOICE does not record audio or store transcripts. Third-party providers (AssemblyAI, Groq, LiveKit) retain data under their own policies.',
  })
}

export const GET = withJsonErrors('account/export', handleGET)
