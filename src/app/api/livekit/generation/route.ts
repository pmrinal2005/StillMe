import { z } from 'zod'
import { getIdentity, json, requireAccount, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { getRoomMeta, updateRoomMeta } from '@/lib/server/livekit'
import { rv } from '@/lib/server/state'
import { resolveOwnedSession, ticketFrom } from '@/lib/server/session'
import { signSessionTicket } from '@/lib/session-ticket'
import { nextGeneration } from '@/lib/generation'
import { sessionGeneration } from '@/lib/server/ops-db'
import { logEvent } from '@/lib/server/log'
import { withJsonErrors } from '@/lib/server/route'
import { ROOM_RE } from '@/lib/spend-refs'

export const dynamic = 'force-dynamic'

const Body = z.object({ room: z.string().regex(ROOM_RE), ticket: z.string().max(2000).optional() })

/**
 * F: generation bump on reconnect.
 *
 * When the owner's device reconnects to the room (network drop, tab restored, LiveKit resume) everything that was drafted or
 * approved BEFORE the gap may refer to partner words the owner never saw. The generation is the version stamp bound into every
 * candidate and every approval; bumping it makes all of them stale at once:
 *   - the web app signs approvals only for the generation it issued (/api/approve compares the ticket's generation);
 *   - the worker refuses an approval of an older generation (`stale_generation`) and restarts turn ids.
 * MONOTONIC and server-issued: max(ticket, room metadata) + 1. A client can never lower or skip it, and two reconnects racing
 * each other both end up strictly increasing (the sealed room metadata is the cross-instance source of truth).
 */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  { const gate = requireAccount(id, 'listening sessions'); if (gate) return gate }
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request' }, 400)
  const { room } = parsed.data
  const s = await resolveOwnedSession(id.userId, room, ticketFrom(req, parsed.data)).catch(() => null)
  if (!s || s.expired) return json({ error: 'not_your_session' }, 403)

  let metaGen = s.generation
  let meta = null
  if (env.livekitUrl() && env.livekitKey() && env.livekitSecret()) {
    meta = await getRoomMeta(room).catch(() => null)
    if (!meta) return json({ error: 'session_ended' }, 410)
    if (meta.ownerIdentity !== id.userId) return json({ error: 'not_your_session' }, 403)
    metaGen = meta.generation
  }
  const generation = nextGeneration(s.generation, metaGen)
  if (meta) await updateRoomMeta(room, { ...meta, generation })
  const cached = rv().sessions.get(id.userId)
  if (cached && cached.room === room) cached.generation = generation
  void sessionGeneration(room, generation) // E48: durable conversation_sessions.generation

  const ticket = await signSessionTicket(env.approvalSecret(), {
    sub: id.userId,
    room,
    conversationId: s.conversationId,
    generation,
    mode: (meta?.mode ?? 'tabletop'),
    startedAt: s.startedAt, // the SAME start: a reconnect never extends the bounded session
    maxMinutes: s.maxMinutes,
    sttMinutes: s.sttMinutes,
    sttDay: s.sttDay ?? new Date(s.startedAt).toISOString().slice(0, 10),
    sttReservationId: s.sttReservationId,
  })
  logEvent({ evt: 'generation_bump', room, status: 'ok' })
  return json({ ok: true, generation, ticket })
}

export const POST = withJsonErrors('livekit/generation', handlePOST)
