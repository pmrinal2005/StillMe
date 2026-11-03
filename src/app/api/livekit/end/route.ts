import { z } from 'zod'
import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { deleteRoom } from '@/lib/server/livekit'
import { settleLocalStt } from '@/lib/server/state'
import { settleDurable } from '@/lib/server/durable'
import { resolveOwnedSession, ticketFrom } from '@/lib/server/session'
import { usedSttMinutes } from '@/lib/session-ticket'
import { logEvent } from '@/lib/server/log'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

const Body = z.object({
  room: z.string().regex(/^rv-[a-f0-9]{24}$/),
  reason: z.enum(['user', 'timeout', 'budget', 'idle', 'error']).default('user'),
  /** Signed session ticket (B4). Also accepted via the x-revoice-session header; sendBeacon can only use the body. */
  ticket: z.string().max(2000).optional(),
})

/**
 * Room closure ends the worker job, which closes the AssemblyAI streams (billed by session duration).
 * Only the owner of the session may close it.
 *
 * B4: ownership is proven by the signed session ticket (or LiveKit room metadata), so this works on
 *     ANY serverless instance — previously it returned not_your_session and the room kept billing.
 * B3: the listening reservation is settled — elapsed minutes committed, the remainder refunded.
 */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request' }, 400)
  const { room, reason } = parsed.data
  try {
    const s = await resolveOwnedSession(id.userId, room, ticketFrom(req, parsed.data), { allowExpired: true })
    if (!s) return json({ error: 'not_your_session' }, 403)
    if (env.livekitUrl()) await deleteRoom(room)
    const used = usedSttMinutes(s)
    const first = settleLocalStt(id.userId, room, used)
    if (s.sttReservationId) await settleDurable(s.sttReservationId, true, used) // idempotent in Postgres
    logEvent({ evt: 'session_end', room, reason, minutes: used, via: s.via, repeat: !first })
    return json({ ok: true, minutesUsed: used })
  } catch (e) {
    logEvent({ evt: 'session_end', status: 'error', room, reason, detail: (e as Error).message?.slice(0, 120) })
    return json({ error: 'end_failed', message: 'Could not close the room; it will close automatically when empty.' }, 502)
  }
}

export const POST = withJsonErrors('livekit/end', handlePOST)
