import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { activeSession, phoneMonthUsed, rv } from '@/lib/server/state'
import { allowedCallMinutes, hashPairCode, newPairCode, PAIR_CODE_TTL_MS } from '@/lib/phone'
import { TELEPHONY } from '@/lib/features'
import { audit } from '@/lib/server/durable'
import { logEvent } from '@/lib/server/log'

export const dynamic = 'force-dynamic'

/**
 * Owner creates a short-lived, single-use pair code bound to THEIR active session.
 * The partner calls the included number and enters it. Caller ID is never sufficient.
 * Refused when telephony is disabled, there is no active session, or the 40-min monthly cap is used.
 */
export async function POST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  if (!env.phoneInboundEnabled() || !env.livekitUrl()) return json({ error: 'phone_disabled' }, 503)
  const s = activeSession(id.userId)
  if (!s) return json({ error: 'no_active_session', message: 'Start a listening session first.' }, 409)
  const minutes = allowedCallMinutes(phoneMonthUsed())
  if (minutes <= 0) return json({ error: 'phone_cap', message: `The ${TELEPHONY.monthlyInboundMinutesCap}-minute monthly phone allowance is used.` }, 429)

  const codes = rv().phoneCodes
  const now = Date.now()
  for (const [k, c] of codes) if (c.expiresAt < now || c.userId === id.userId) codes.delete(k) // one live code per owner
  let code = newPairCode()
  let key = await hashPairCode(env.approvalSecret(), code)
  for (let i = 0; codes.has(key) && i < 5; i++) {
    code = newPairCode()
    key = await hashPairCode(env.approvalSecret(), code)
  }
  const expiresAt = now + PAIR_CODE_TTL_MS
  codes.set(key, { userId: id.userId, room: s.room, expiresAt, attempts: 0 })
  logEvent({ evt: 'phone_code_issued', room: s.room })
  void audit(id.userId, 'phone_code_issued', s.room)
  return json({ code, expiresAt, number: env.phoneNumberDisplay() ?? null, maxCallMinutes: minutes, monthUsed: phoneMonthUsed(), monthCap: TELEPHONY.monthlyInboundMinutesCap })
}

/** Owner revokes any outstanding code (e.g. read aloud to the wrong person). */
export async function DELETE(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  for (const [k, c] of rv().phoneCodes) if (c.userId === id.userId) rv().phoneCodes.delete(k)
  return json({ ok: true })
}
