import { z } from 'zod'
import { getIdentity, json } from '@/lib/server/auth'
import { getRoomMeta, signInvite } from '@/lib/server/livekit'
import { resolveOwnedSession, ticketFrom } from '@/lib/server/session'
import { allow } from '@/lib/server/rate-limit'
import { audit } from '@/lib/server/durable'
import { ROOM_RE } from '@/lib/spend-refs'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

const Body = z.object({ room: z.string().regex(ROOM_RE), ticket: z.string().max(2000).optional() })

/**
 * B17: partner invites are single use, so the OWNER of a live partner-link / remote room mints a fresh one for each
 * additional partner. Only the room's owner (signed session ticket, or LiveKit's server-set owner) may do this.
 */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request' }, 400)
  const { room } = parsed.data
  if (!allow(`invite:${id.userId}`, 10, 30 * 60_000)) return json({ error: 'rate_limited', message: 'Too many partner links in a short time.' }, 429)
  const s = await resolveOwnedSession(id.userId, room, ticketFrom(req, parsed.data)).catch(() => null)
  if (!s || s.expired) return json({ error: 'not_your_session' }, 403)
  const meta = await getRoomMeta(room).catch(() => undefined)
  if (meta === undefined) return json({ error: 'livekit_unreachable' }, 502)
  if (!meta || meta.ownerIdentity !== id.userId) return json({ error: 'not_your_session' }, 403)
  if (meta.mode === 'tabletop') return json({ error: 'no_partner_in_tabletop', message: 'Tabletop conversations have no partner link.' }, 409)
  const inv = await signInvite(room, id.userId)
  void audit(id.userId, 'invite_minted', room)
  return json({ invite: inv.invite, expiresAt: inv.exp })
}

export const POST = withJsonErrors('livekit/invite', handlePOST)
