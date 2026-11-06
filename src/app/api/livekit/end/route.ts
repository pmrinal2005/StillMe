import { z } from 'zod'
import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { deleteRoom } from '@/lib/server/livekit'
import { settleLocalStt } from '@/lib/server/state'
import { resolveOwnedSession, ticketFrom, type ResolvedSession } from '@/lib/server/session'
import { verifySessionTicket } from '@/lib/session-ticket'
import { durableSttByRoom, durableSubject, settleByRef, settleDurableId } from '@/lib/server/spend'
import { DIRECT_STT_RE, ROOM_RE, sttMinutesToCommit } from '@/lib/spend-refs'
import { logEvent } from '@/lib/server/log'
import { withJsonErrors } from '@/lib/server/route'
import { sessionClose } from '@/lib/server/ops-db'

export const dynamic = 'force-dynamic'

const Body = z.object({
  /** LiveKit room (rv-…) or a browser-direct STT session id (sd-…, A7). */
  room: z.string().refine((r) => ROOM_RE.test(r) || DIRECT_STT_RE.test(r), 'invalid_room'),
  reason: z.enum(['user', 'timeout', 'budget', 'idle', 'error']).default('user'),
  /** Signed session ticket (B4). Also accepted via the x-revoice-session header; sendBeacon can only use the body. */
  ticket: z.string().max(2000).optional(),
})

/**
 * Close the room (ends the worker job → closes the AssemblyAI streams) and settle the listening reservation.
 *
 * A2  Ticket-only authorization: a valid signed ticket for (caller, room) is sufficient, even when the room
 *     is already gone and this instance has no cache — previously an already-closed room could not be
 *     settled and its whole reservation stayed "reserved".
 * A3  The durable reservation is found by id (ticket) OR by ref = room (no ticket id / legacy ticket), and
 *     settled with the wall-clock upper bound. The worker's measured CONNECTED minutes later correct it
 *     authoritatively via /api/worker/usage (A10); the sweep commits anything still open.
 * A7  Browser-direct STT sessions (sd-…) are settled the same way (no LiveKit room to delete).
 */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request' }, 400)
  const { room, reason } = parsed.data
  const ticket = ticketFrom(req, parsed.data)
  const direct = DIRECT_STT_RE.test(room)
  try {
    let s: ResolvedSession | null = null
    // A2: ticket first and alone — no LiveKit round-trip and no instance memory needed.
    if (ticket) {
      const v = await verifySessionTicket(env.approvalSecret(), ticket, { sub: id.userId, room, allowExpired: true })
      if (v.ok) {
        const t = v.ticket
        s = { room, conversationId: t.conversationId, generation: t.generation, startedAt: t.startedAt, maxMinutes: t.maxMinutes, sttMinutes: t.sttMinutes, sttDay: t.sttDay, sttReservationId: t.sttReservationId, via: 'ticket', expired: v.expired }
      }
    }
    if (!s && !direct) s = await resolveOwnedSession(id.userId, room, null, { allowExpired: true }).catch(() => null)
    if (!s) return json({ error: 'not_your_session' }, 403)

    if (!direct && env.livekitUrl()) await deleteRoom(room).catch(() => undefined) // already-gone rooms are fine

    const used = sttMinutesToCommit({ reserved: s.sttMinutes, startedAt: s.startedAt })
    const first = settleLocalStt(id.userId, room, used)

    // A3: durable settlement by id, else by ref (room). Both only touch rows still 'reserved' (idempotent).
    let settled = 0
    if (s.sttReservationId) await settleDurableId(s.sttReservationId, 'assemblyai_stt', true, used)
    else {
      settled = await settleByRef(room, 'assemblyai_stt', true, used, false)
      if (!settled) {
        const subj = await durableSubject(id, req)
        const row = await durableSttByRoom(subj.subject, room)
        if (row?.status === 'reserved') await settleDurableId(row.id, 'assemblyai_stt', true, sttMinutesToCommit({ reserved: row.units, startedAt: row.createdAt }))
      }
    }
    if (!direct) void sessionClose(room, reason) // E48
    logEvent({ evt: 'session_end', room, reason, minutes: used, via: s.via, repeat: !first, byRef: settled > 0 })
    return json({ ok: true, minutesUsed: used })
  } catch (e) {
    logEvent({ evt: 'session_end', status: 'error', room, reason, detail: (e as Error).message?.slice(0, 120) })
    return json({ error: 'end_failed', message: 'Could not close the room; it will close automatically when empty.' }, 502)
  }
}

export const POST = withJsonErrors('livekit/end', handlePOST)
