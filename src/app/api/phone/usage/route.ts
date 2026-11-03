import { z } from 'zod'
import { json } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { rv } from '@/lib/server/state'
import { verifyWorkerAuth } from '@/lib/server/worker-auth'
import { recordUsage, settlePhoneCallDurable } from '@/lib/server/durable'
import { logEvent } from '@/lib/server/log'
import { TELEPHONY } from '@/lib/features'
import { withJsonErrors } from '@/lib/server/route'
import { livekitRoomStore, takePhoneCall } from '@/lib/server/phone-store'

export const dynamic = 'force-dynamic'

const Body = z.object({ room: z.string().regex(/^rv-[a-f0-9]{24}$/), minutes: z.number().min(0).max(TELEPHONY.maxCallMinutes + 1) })

/**
 * Worker-only (HMAC). Settles a finished call: the reservation is replaced by actual minutes
 * (rounded UP — LiveKit bills started minutes). Content-free.
 *
 * Cross-instance (open item): the reservation is read from (and cleared in) the owner room's LiveKit
 * metadata, so settlement works no matter which instance handled /api/phone/bind. The instance cache
 * is cleared too so it is never double-counted here.
 */
async function handlePOST(req: Request) {
  const raw = await req.text()
  if (!(await verifyWorkerAuth(env.approvalSecret(), req.headers.get('x-revoice-worker'), raw))) return json({ error: 'unauthorized' }, 401)
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: 'invalid_request' }, 400)
  }
  const parsed = Body.safeParse(body)
  if (!parsed.success) return json({ error: 'invalid_request' }, 400)
  const { room, minutes } = parsed.data
  const state = rv()

  // Reservation: LiveKit metadata (any instance) first, else this instance's cache.
  let res: { minutes: number; month: string; userId: string } | null = null
  if (env.livekitUrl() && env.livekitKey() && env.livekitSecret()) {
    const t = await takePhoneCall(await livekitRoomStore(), room).catch(() => null)
    if (t) res = { minutes: t.call.minutes, month: t.call.month, userId: t.meta.ownerIdentity }
  }
  for (const [k, r] of state.phoneReservations) {
    if (!k.startsWith(`${room}:`)) continue
    state.phoneReservations.delete(k)
    res = res ?? { minutes: r.minutes, month: r.month, userId: r.userId }
  }
  let settled = 0
  if (res) {
    settled = Math.min(res.minutes, Math.ceil(minutes))
    state.phoneMinutes.set(res.month, (state.phoneMinutes.get(res.month) ?? 0) + settled)
    void recordUsage({ userId: res.userId, provider: 'livekit', kind: 'phone_inbound', units: settled })
  }
  await settlePhoneCallDurable(room, minutes)
  logEvent({ evt: 'phone_usage', room, minutes: settled })
  return json({ ok: true, minutes: settled })
}

export const POST = withJsonErrors('phone/usage', handlePOST)
