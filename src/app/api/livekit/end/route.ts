import { z } from 'zod'
import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { deleteRoom } from '@/lib/server/livekit'

export const dynamic = 'force-dynamic'

/** Room closure ends the worker job, which closes the AssemblyAI streams (billed by session duration). */
export async function POST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  const parsed = z.object({ room: z.string().regex(/^rv-[a-f0-9]{24}$/) }).safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request' }, 400)
  if (!env.livekitUrl()) return json({ ok: true })
  await deleteRoom(parsed.data.room)
  return json({ ok: true })
}
