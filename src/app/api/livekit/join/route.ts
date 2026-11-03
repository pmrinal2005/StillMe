import { z } from 'zod'
import { json } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { getRoomMeta, partnerToken, verifyInvite } from '@/lib/server/livekit'
import { logEvent } from '@/lib/server/log'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

const Body = z.object({ invite: z.string().max(400), label: z.string().max(40).default('Partner'), consent: z.literal(true) })

/** Partner joins via an expiring signed invite and must acknowledge transcription disclosure. */
async function handlePOST(req: Request) {
  if (!env.livekitUrl() || !env.livekitKey() || !env.livekitSecret()) return json({ error: 'livekit_not_configured' }, 503)
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request', message: 'Consent to transcription is required to join.' }, 400)
  try {
    // B2: invites now verify on every instance because the HMAC secret is stable/derived.
    const inv = await verifyInvite(parsed.data.invite)
    if (!inv) return json({ error: 'invite_invalid_or_expired' }, 403)
    // The room must still exist and belong to the inviter (session may have ended on another instance).
    const meta = await getRoomMeta(inv.room).catch(() => undefined)
    if (meta === null || (meta && meta.ownerIdentity !== inv.ownerIdentity)) return json({ error: 'session_ended', message: 'This conversation has ended.' }, 410)
    // B1: partnerToken now passes TrackSource.MICROPHONE (enum) so toJwt() no longer throws.
    const { token, identity } = await partnerToken({ room: inv.room, label: parsed.data.label })
    return json({ url: env.livekitUrl(), token, identity, room: inv.room })
  } catch (e) {
    logEvent({ evt: 'partner_join', status: 'error', detail: (e as Error).message?.slice(0, 120) })
    return json({ error: 'join_failed', message: 'Could not join right now. Please try again.' }, 502)
  }
}

export const POST = withJsonErrors('livekit/join', handlePOST)
