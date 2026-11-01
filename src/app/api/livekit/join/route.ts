import { z } from 'zod'
import { json } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { partnerToken, verifyInvite } from '@/lib/server/livekit'

export const dynamic = 'force-dynamic'

const Body = z.object({ invite: z.string().max(400), label: z.string().max(40).default('Partner'), consent: z.literal(true) })

/** Partner joins via an expiring signed invite and must acknowledge transcription disclosure. */
export async function POST(req: Request) {
  if (!env.livekitUrl()) return json({ error: 'livekit_not_configured' }, 503)
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request', message: 'Consent to transcription is required to join.' }, 400)
  const inv = await verifyInvite(parsed.data.invite)
  if (!inv) return json({ error: 'invite_invalid_or_expired' }, 403)
  const { token, identity } = await partnerToken({ room: inv.room, label: parsed.data.label })
  return json({ url: env.livekitUrl(), token, identity, room: inv.room })
}
