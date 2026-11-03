import { z } from 'zod'
import { json } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { monthKey, phoneMonthUsed, rv } from '@/lib/server/state'
import { allowedCallMinutes, BINDING_TTL_MS, hashPairCode, isPairCode, signPhoneBinding } from '@/lib/phone'
import { verifyWorkerAuth } from '@/lib/server/worker-auth'
import { audit, reservePhoneCallDurable } from '@/lib/server/durable'
import { TELEPHONY } from '@/lib/features'
import { logEvent } from '@/lib/server/log'
import { withJsonErrors } from '@/lib/server/route'
import { consumePairCode, dropPairCode, livekitRoomStore, lookupPairCode } from '@/lib/server/phone-store'

export const dynamic = 'force-dynamic'

const Body = z.object({
  code: z.string().refine(isPairCode),
  identity: z.string().regex(/^[A-Za-z0-9_+.:-]{1,128}$/),
  callRoom: z.string().regex(/^call-[A-Za-z0-9_-]{1,100}$/),
})

/**
 * Worker-only (HMAC). Validates a DTMF pair code against an ACTIVE owner session and the monthly cap,
 * reserves the call's minutes, and returns a signed binding the owner-room worker will verify before
 * it transcribes the caller. Codes are single use; wrong guesses are bounded.
 *
 * Cross-instance (open item): the code is looked up in the owner rooms' LiveKit metadata (hashed),
 * not in this instance's memory. A room that still exists IS the active session (rooms are deleted on
 * end — B3/B4), so no instance-local session cache is consulted.
 */
async function handlePOST(req: Request) {
  const raw = await req.text()
  if (!(await verifyWorkerAuth(env.approvalSecret(), req.headers.get('x-revoice-worker'), raw))) return json({ error: 'unauthorized' }, 401)
  if (!env.phoneInboundEnabled()) return json({ error: 'phone_disabled' }, 503)
  if (!env.livekitUrl() || !env.livekitKey() || !env.livekitSecret()) return json({ error: 'livekit_not_configured' }, 503)
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    return json({ error: 'invalid_request' }, 400)
  }
  const parsed = Body.safeParse(parsedJson)
  if (!parsed.success) return json({ error: 'invalid_code' }, 400)
  const { code, identity } = parsed.data

  const key = await hashPairCode(env.approvalSecret(), code)
  const now = Date.now()
  rv().phoneCodes.delete(key) // instance cache is advisory only
  const store = await livekitRoomStore()
  const found = await lookupPairCode(store, key, now)
  if (!found.ok) {
    logEvent({ evt: 'phone_bind', status: 'rejected', reason: 'invalid_code' })
    return json({ error: 'invalid_code' }, 403)
  }
  const { room, meta } = found
  if (meta.phoneCall) {
    await dropPairCode(store, room)
    return json({ error: 'call_in_progress' }, 409)
  }
  const minutes = allowedCallMinutes(phoneMonthUsed(now))
  if (minutes <= 0) {
    await dropPairCode(store, room)
    return json({ error: 'phone_cap' }, 429)
  }
  // Durable monthly reservation (cross-instance) intersects with the in-process ledger.
  const d = await reservePhoneCallDurable(meta.ownerIdentity, room, identity, TELEPHONY.monthlyInboundMinutesCap, minutes)
  if (d && !d.ok) {
    await dropPairCode(store, room)
    return json({ error: 'phone_cap', reason: d.reason }, 429)
  }
  const granted = d?.ok ? Math.min(minutes, d.minutes) : minutes

  const call = { identity, minutes: granted, month: monthKey(now), at: now }
  await consumePairCode(store, room, call) // single use + cross-instance call reservation, one metadata write
  rv().phoneReservations.set(`${room}:${identity}`, { minutes: granted, month: call.month, userId: meta.ownerIdentity, at: now })
  const binding = await signPhoneBinding(env.approvalSecret(), room, identity, now + BINDING_TTL_MS, granted)
  logEvent({ evt: 'phone_bind', status: 'ok', room, minutes: granted })
  void audit(meta.ownerIdentity, 'phone_bound', room)
  return json({ ok: true, room, binding, maxMinutes: granted })
}

export const POST = withJsonErrors('phone/bind', handlePOST)
