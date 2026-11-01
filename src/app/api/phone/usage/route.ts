import { z } from 'zod'
import { json } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { rv } from '@/lib/server/state'
import { verifyWorkerAuth } from '@/lib/server/worker-auth'
import { recordUsage, settlePhoneCallDurable } from '@/lib/server/durable'
import { logEvent } from '@/lib/server/log'
import { TELEPHONY } from '@/lib/features'

export const dynamic = 'force-dynamic'

const Body = z.object({ room: z.string().regex(/^rv-[a-f0-9]{24}$/), minutes: z.number().min(0).max(TELEPHONY.maxCallMinutes + 1) })

/**
 * Worker-only (HMAC). Settles a finished call: the reservation is replaced by actual minutes
 * (rounded UP — LiveKit bills started minutes). Content-free.
 */
export async function POST(req: Request) {
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
  const state = rv()
  let settled = 0
  for (const [k, r] of state.phoneReservations) {
    if (!k.startsWith(`${parsed.data.room}:`)) continue
    const used = Math.min(r.minutes, Math.ceil(parsed.data.minutes))
    state.phoneMinutes.set(r.month, (state.phoneMinutes.get(r.month) ?? 0) + used)
    state.phoneReservations.delete(k)
    void recordUsage({ userId: r.userId, provider: 'livekit', kind: 'phone_inbound', units: used })
    settled = used
  }
  await settlePhoneCallDurable(parsed.data.room, parsed.data.minutes)
  logEvent({ evt: 'phone_usage', room: parsed.data.room, minutes: settled })
  return json({ ok: true, minutes: settled })
}
