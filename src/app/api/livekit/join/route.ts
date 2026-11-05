import { z } from 'zod'
import { json } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { getRoomMeta, parseInvite, partnerToken, verifyInvite } from '@/lib/server/livekit'
import { consumeInvite } from '@/lib/server/invites'
import { allow } from '@/lib/server/rate-limit'
import { clientIp } from '@/lib/server/spend'
import { logEvent } from '@/lib/server/log'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

const Body = z.object({ invite: z.string().max(400), label: z.string().max(40).default('Partner'), consent: z.literal(true) })

/**
 * Partner joins via an expiring, SINGLE-USE signed invite and must acknowledge transcription disclosure.
 *
 * B17: the link carries no user id. The owner is recovered from the SEALED room metadata (server-set at creation) and
 * bound into the invite signature, so a forged/edited invite fails; the invite id is then consumed atomically, so a
 * second use (any instance) is refused. The owner mints a fresh link per additional partner (/api/livekit/invite).
 */
async function handlePOST(req: Request) {
  if (!env.livekitUrl() || !env.livekitKey() || !env.livekitSecret()) return json({ error: 'livekit_not_configured' }, 503)
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request', message: 'Consent to transcription is required to join.' }, 400)
  // Cheap per-instance brake against invite guessing / hammering from one address.
  if (!allow(`join:${clientIp(req) ?? 'unknown'}`, 20, 10 * 60_000)) return json({ error: 'rate_limited', message: 'Too many attempts. Please wait a few minutes.' }, 429)
  try {
    const p = parseInvite(parsed.data.invite)
    if (!p || Date.now() > p.exp) return json({ error: 'invite_invalid_or_expired' }, 403)
    // The room (and therefore the owner) must still exist. Lookup errors fail CLOSED (we need the owner to verify).
    const meta = await getRoomMeta(p.room)
    if (!meta) return json({ error: 'session_ended', message: 'This conversation has ended.' }, 410)
    if (meta.mode === 'tabletop') return json({ error: 'invite_invalid_or_expired' }, 403)
    const inv = await verifyInvite(parsed.data.invite, meta.ownerIdentity)
    if (!inv) return json({ error: 'invite_invalid_or_expired' }, 403)
    const used = await consumeInvite(inv.jti, inv.room, inv.exp)
    if (used === 'used') return json({ error: 'invite_used', message: 'This link was already used. Ask for a new one.' }, 403)
    if (used === 'unavailable') return json({ error: 'invite_store_unavailable', message: 'Could not verify this link right now. Please try again.' }, 503)
    // B1: partnerToken passes TrackSource.MICROPHONE (enum) so toJwt() does not throw.
    const { token, identity } = await partnerToken({ room: inv.room, label: parsed.data.label })
    logEvent({ evt: 'partner_join', status: 'ok', room: inv.room })
    return json({ url: env.livekitUrl(), token, identity, room: inv.room })
  } catch (e) {
    logEvent({ evt: 'partner_join', status: 'error', detail: (e as Error).message?.slice(0, 120) })
    return json({ error: 'join_failed', message: 'Could not join right now. Please try again.' }, 502)
  }
}

export const POST = withJsonErrors('livekit/join', handlePOST)
