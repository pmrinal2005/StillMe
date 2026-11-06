import { getIdentity, json } from '@/lib/server/auth'
import { ledgerFor } from '@/lib/server/state'
import { userMeters } from '@/lib/status-view'
import { exportDeviceData } from '@/lib/server/account'
import { voiceStoreFor } from '@/lib/server/voice-registry'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

/**
 * Server-side export for THIS DEVICE: cloned-voice registry and consent history, session metadata and the caller's own
 * daily meters. Phrase boards, preferences and the message bank live only in this browser (IndexedDB) and are exported
 * client-side.
 */
async function handleGET(req: Request) {
  const id = await getIdentity(req)
  const voices = await voiceStoreFor(id.userId).list(id.userId).catch(() => [])
  return json({
    exportedAt: new Date().toISOString(),
    // B18: the caller's own daily meters only — the raw snapshot carries lifetime/spendable (shared project credit).
    usage: userMeters(ledgerFor(id.userId).snapshot()),
    voices,
    database: await exportDeviceData(id),
    note: 'ReVOICE does not record audio or store transcripts. Third-party providers (AssemblyAI, Groq, LiveKit) retain data under their own policies.',
  })
}

export const GET = withJsonErrors('account/export', handleGET)
