/**
 * Signed session ticket (B4 fix).
 *
 * Problem: the active-session record lived only in serverless memory, so on Vercel a request
 * served by a different instance saw "no session" → /api/approve returned wrong_room and
 * /api/livekit/end returned not_your_session (the room was never deleted and STT kept billing).
 *
 * Fix: the instance that starts a session returns a stateless, HMAC-signed ticket that the owner's
 * device sends back on every session-scoped request. Any instance holding the shared approval
 * secret (B2) can verify it. Format:  rvs1.<base64url(JSON payload)>.<hex hmac("session:"+payload)>
 *
 * The ticket is bound to the authenticated user (sub) and room, and expires shortly after the
 * session's bounded duration. It carries the STT budget reservation so ANY instance can settle it (B3).
 */
import { hmacSha256Hex, timingSafeEqualHex } from './hash'

export const TICKET_PREFIX = 'rvs1'
/** Slack after maxMinutes before the ticket stops authorizing speech approvals. */
export const TICKET_GRACE_MS = 2 * 60_000
/** Expired tickets may still END/settle their own session for this long (stale-session cleanup). */
export const TICKET_SETTLE_WINDOW_MS = 24 * 60 * 60_000

export interface SessionTicket {
  v: 1
  sub: string
  room: string
  conversationId: string
  generation: number
  mode: 'tabletop' | 'partner-link' | 'remote'
  startedAt: number
  maxMinutes: number
  /** Minutes reserved against the listening budget at start. */
  sttMinutes: number
  /** UTC day (YYYY-MM-DD) the reservation was made on. */
  sttDay: string
  /** Durable (Supabase) budget reservation id, if a durable store is configured. */
  sttReservationId: string | null
  exp: number
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function b64urlEncode(s: string): string {
  const bytes = enc.encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  return dec.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export function ticketExpiry(startedAt: number, maxMinutes: number): number {
  return startedAt + maxMinutes * 60_000 + TICKET_GRACE_MS
}

export async function signSessionTicket(secret: string, t: Omit<SessionTicket, 'v' | 'exp'> & { exp?: number }): Promise<string> {
  const full: SessionTicket = { v: 1, ...t, exp: t.exp ?? ticketExpiry(t.startedAt, t.maxMinutes) }
  const payload = b64urlEncode(JSON.stringify(full))
  const sig = await hmacSha256Hex(secret, `session:${payload}`)
  return `${TICKET_PREFIX}.${payload}.${sig}`
}

export type TicketCheck =
  | { ok: true; ticket: SessionTicket; expired: boolean }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_user' | 'wrong_room' }

/**
 * Verify a ticket. `allowExpired` lets /api/livekit/end settle/close a session after its window
 * (bounded by TICKET_SETTLE_WINDOW_MS); speech approval never allows expired tickets.
 */
export async function verifySessionTicket(
  secret: string,
  raw: string | null | undefined,
  opts: { sub?: string; room?: string; now?: number; allowExpired?: boolean } = {},
): Promise<TicketCheck> {
  if (!raw || raw.length > 2000) return { ok: false, reason: 'malformed' }
  const parts = raw.split('.')
  if (parts.length !== 3 || parts[0] !== TICKET_PREFIX || !/^[a-f0-9]{64}$/.test(parts[2])) return { ok: false, reason: 'malformed' }
  const [, payload, sig] = parts
  const expected = await hmacSha256Hex(secret, `session:${payload}`)
  if (!timingSafeEqualHex(expected, sig)) return { ok: false, reason: 'bad_signature' }
  let t: SessionTicket
  try {
    t = JSON.parse(b64urlDecode(payload)) as SessionTicket
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (t?.v !== 1 || typeof t.sub !== 'string' || typeof t.room !== 'string' || typeof t.exp !== 'number') return { ok: false, reason: 'malformed' }
  const now = opts.now ?? Date.now()
  const expired = now > t.exp
  if (expired && (!opts.allowExpired || now > t.exp + TICKET_SETTLE_WINDOW_MS)) return { ok: false, reason: 'expired' }
  if (opts.sub !== undefined && t.sub !== opts.sub) return { ok: false, reason: 'wrong_user' }
  if (opts.room !== undefined && t.room !== opts.room) return { ok: false, reason: 'wrong_room' }
  return { ok: true, ticket: t, expired }
}

/** Minutes to commit when a session ends: elapsed wall time rounded up, clamped to the reservation. */
export function usedSttMinutes(t: Pick<SessionTicket, 'startedAt' | 'sttMinutes'>, now = Date.now()): number {
  const elapsed = Math.max(0, now - t.startedAt)
  return Math.min(t.sttMinutes, Math.max(0, Math.ceil(elapsed / 60_000)))
}
