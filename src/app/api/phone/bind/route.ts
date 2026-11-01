import { z } from 'zod'
import { json } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { activeSession, monthKey, phoneMonthUsed, rv } from '@/lib/server/state'
import { allowedCallMinutes, BINDING_TTL_MS, hashPairCode, isPairCode, MAX_BIND_ATTEMPTS_PER_CODE, signPhoneBinding } from '@/lib/phone'
import { verifyWorkerAuth } from '@/lib/server/worker-auth'
import { audit, reservePhoneCallDurable } from '@/lib/server/durable'
import { TELEPHONY } from '@/lib/features'
import { logEvent } from '@/lib/server/log'

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
 */
export async function POST(req: Request) {
  const raw = await req.text()
  if (!(await verifyWorkerAuth(env.approvalSecret(), req.headers.get('x-revoice-worker'), raw))) return json({ error: 'unauthorized' }, 401)
  if (!env.phoneInboundEnabled()) return json({ error: 'phone_disabled' }, 503)
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    return json({ error: 'invalid_request' }, 400)
  }
  const parsed = Body.safeParse(parsedJson)
  if (!parsed.success) return json({ error: 'invalid_code' }, 400)
  const { code, identity } = parsed.data

  const codes = rv().phoneCodes
  const key = await hashPairCode(env.approvalSecret(), code)
  const entry = codes.get(key)
  const now = Date.now()
  if (!entry || entry.expiresAt < now) {
    if (entry) codes.delete(key)
    logEvent({ evt: 'phone_bind', status: 'rejected', reason: 'invalid_code' })
    return json({ error: 'invalid_code' }, 403)
  }
  entry.attempts += 1
  if (entry.attempts > MAX_BIND_ATTEMPTS_PER_CODE) {
    codes.delete(key)
    return json({ error: 'invalid_code' }, 403)
  }
  const s = activeSession(entry.userId)
  if (!s || s.room !== entry.room) {
    codes.delete(key)
    return json({ error: 'no_active_session' }, 409)
  }
  const minutes = allowedCallMinutes(phoneMonthUsed(now))
  if (minutes <= 0) {
    codes.delete(key)
    return json({ error: 'phone_cap' }, 429)
  }
  // Durable monthly reservation (cross-instance) intersects with the in-process ledger.
  const d = await reservePhoneCallDurable(entry.userId, s.room, identity, TELEPHONY.monthlyInboundMinutesCap, minutes)
  if (d && !d.ok) {
    codes.delete(key)
    return json({ error: 'phone_cap', reason: d.reason }, 429)
  }
  const granted = d?.ok ? Math.min(minutes, d.minutes) : minutes

  codes.delete(key) // single use
  rv().phoneReservations.set(`${s.room}:${identity}`, { minutes: granted, month: monthKey(now), userId: entry.userId, at: now })
  const binding = await signPhoneBinding(env.approvalSecret(), s.room, identity, now + BINDING_TTL_MS, granted)
  logEvent({ evt: 'phone_bind', status: 'ok', room: s.room, minutes: granted })
  void audit(entry.userId, 'phone_bound', s.room)
  return json({ ok: true, room: s.room, binding, maxMinutes: granted })
}
