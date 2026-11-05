import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { ledgerFor } from '@/lib/server/state'
import { userMeters } from '@/lib/status-view'
import { exportAccountData } from '@/lib/server/account'
import { voiceStoreFor } from '@/lib/server/voice-registry'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

/**
 * B19: server-side export. Phrase boards, style card, preferences and consent history are exported from the DATABASE
 * (service role, filtered to the caller) — not only from the browser — so the export is complete on a new device.
 * Device-only data (IndexedDB) is still exported client-side.
 */
async function handleGET(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  const voices = id.kind === 'guest' ? [] : await voiceStoreFor(id.userId).list(id.userId).catch(() => [])
  return json({
    exportedAt: new Date().toISOString(),
    identity: { kind: id.kind },
    // B18: the caller's own daily meters only — the raw snapshot carries lifetime/spendable (shared project credit).
    usage: userMeters(ledgerFor(id.userId).snapshot()),
    voices,
    database: await exportAccountData(id),
    note: 'ReVOICE does not record audio or store transcripts. Third-party providers (AssemblyAI, Groq, LiveKit) retain data under their own policies.',
  })
}

export const GET = withJsonErrors('account/export', handleGET)
