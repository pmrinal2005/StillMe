import { z } from 'zod'
import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { deleteRoom } from '@/lib/server/livekit'
import { activeSession, rv } from '@/lib/server/state'
import { logEvent } from '@/lib/server/log'

export const dynamic = 'force-dynamic'

/**
 * Room closure ends the worker job, which closes the AssemblyAI streams (billed by session duration).
 * Only the owner of the active session may close it.
 */
export async function POST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  const parsed = z.object({ room: z.string().regex(/^rv-[a-f0-9]{24}$/), reason: z.enum(['user', 'timeout', 'budget', 'idle', 'error']).default('user') }).safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request' }, 400)
  const s = activeSession(id.userId)
  if (!s || s.room !== parsed.data.room) return json({ error: 'not_your_session' }, 403)
  rv().sessions.delete(id.userId)
  if (env.livekitUrl()) await deleteRoom(parsed.data.room)
  logEvent({ evt: 'session_end', room: parsed.data.room, reason: parsed.data.reason, minutes: Math.round((Date.now() - s.startedAt) / 60000) })
  return json({ ok: true })
}
