import 'server-only'
import { env } from './env'
import { getRoomMeta, type RoomMetadata } from './livekit'
import { activeSession } from './state'
import { verifySessionTicket, type SessionTicket } from '../session-ticket'

/** Header the owner's device uses to present its signed session ticket (B4). */
export const SESSION_TICKET_HEADER = 'x-revoice-session'

export function ticketFrom(req: Request, body?: { ticket?: unknown } | null): string | null {
  const h = req.headers.get(SESSION_TICKET_HEADER)
  if (h) return h
  return typeof body?.ticket === 'string' ? body.ticket : null
}

export interface ResolvedSession {
  room: string
  conversationId: string
  generation: number
  startedAt: number
  maxMinutes: number
  sttMinutes: number
  sttDay: string | null
  sttReservationId: string | null
  /** Where the authorization came from (diagnostics only; never logged with content). */
  via: 'ticket' | 'cache' | 'livekit'
  expired: boolean
}

function fromTicket(t: SessionTicket, expired: boolean): ResolvedSession {
  return { room: t.room, conversationId: t.conversationId, generation: t.generation, startedAt: t.startedAt, maxMinutes: t.maxMinutes, sttMinutes: t.sttMinutes, sttDay: t.sttDay, sttReservationId: t.sttReservationId, via: 'ticket', expired }
}

function fromMeta(room: string, m: RoomMetadata): ResolvedSession {
  return {
    room,
    conversationId: m.conversationId,
    generation: m.generation,
    startedAt: m.startedAt ?? Date.now(),
    maxMinutes: m.maxSessionMinutes,
    sttMinutes: m.sttMinutes ?? m.maxSessionMinutes,
    sttDay: m.startedAt ? new Date(m.startedAt).toISOString().slice(0, 10) : null,
    sttReservationId: m.sttReservationId ?? null,
    via: 'livekit',
    expired: false,
  }
}

/**
 * B4: resolve the caller's session for `room` WITHOUT relying on serverless memory.
 * Order: (1) signed session ticket, (2) this instance's cache, (3) LiveKit room metadata
 * (server-set at creation; ownerIdentity must equal the caller). Returns null if not the caller's.
 *
 * `allowExpired` is used only for ending/settling a session, never for authorizing speech.
 */
export async function resolveOwnedSession(userId: string, room: string, ticket: string | null, opts: { allowExpired?: boolean } = {}): Promise<ResolvedSession | null> {
  if (ticket) {
    const v = await verifySessionTicket(env.approvalSecret(), ticket, { sub: userId, room, allowExpired: opts.allowExpired })
    if (v.ok) return fromTicket(v.ticket, v.expired)
  }
  const c = activeSession(userId)
  if (c && c.room === room) {
    return { room, conversationId: c.conversationId, generation: c.generation, startedAt: c.startedAt, maxMinutes: c.maxMinutes, sttMinutes: c.sttMinutes, sttDay: c.sttDay, sttReservationId: c.sttReservationId, via: 'cache', expired: false }
  }
  if (env.livekitUrl() && env.livekitKey() && env.livekitSecret()) {
    const m = await getRoomMeta(room).catch(() => null)
    if (m && m.ownerIdentity === userId) return fromMeta(room, m)
  }
  return null
}

/** Ticket-only lookup for routes that need "the caller's current session" without a room name (e.g. phone pairing). */
export async function resolveCurrentSession(userId: string, ticket: string | null): Promise<ResolvedSession | null> {
  if (ticket) {
    const v = await verifySessionTicket(env.approvalSecret(), ticket, { sub: userId })
    if (v.ok) {
      // Make sure the room still exists (it may have been ended from another device/instance).
      if (env.livekitUrl()) {
        const m = await getRoomMeta(v.ticket.room).catch(() => undefined)
        if (m === null) return null
      }
      return fromTicket(v.ticket, false)
    }
  }
  const c = activeSession(userId)
  if (c) return { room: c.room, conversationId: c.conversationId, generation: c.generation, startedAt: c.startedAt, maxMinutes: c.maxMinutes, sttMinutes: c.sttMinutes, sttDay: c.sttDay, sttReservationId: c.sttReservationId, via: 'cache', expired: false }
  return null
}
