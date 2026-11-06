import { getIdentity, json } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { phoneMonthUsedDurable, rv } from '@/lib/server/state'
import { resolveCurrentSession, ticketFrom } from '@/lib/server/session'
import { allowedCallMinutes, hashPairCode, newPairCode, PAIR_CODE_TTL_MS } from '@/lib/phone'
import { TELEPHONY } from '@/lib/features'
import { audit } from '@/lib/server/durable'
import { logEvent } from '@/lib/server/log'
import { withJsonErrors } from '@/lib/server/route'
import { livekitRoomStore, revokePairCodes, storePairCode } from '@/lib/server/phone-store'
import { pairIssueDurable, pairRevokeDurable } from '@/lib/server/ops-db'

export const dynamic = 'force-dynamic'

/**
 * Owner creates a short-lived, single-use pair code bound to THEIR active session.
 * The partner calls the included number and enters it. Caller ID is never sufficient.
 * Refused when telephony is disabled, there is no active session, or the 40-min monthly cap is used.
 */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!env.phoneInboundEnabled() || !env.livekitUrl()) return json({ error: 'phone_disabled' }, 503)
  const s = await resolveCurrentSession(id.userId, ticketFrom(req)).catch(() => null) // B4: ticket, not instance memory
  if (!s) return json({ error: 'no_active_session', message: 'Start a listening session first.' }, 409)
  const monthUsed = await phoneMonthUsedDurable() // D #46: durable total, not this instance's memory
  const minutes = allowedCallMinutes(monthUsed)
  if (minutes <= 0) return json({ error: 'phone_cap', message: `The ${TELEPHONY.monthlyInboundMinutesCap}-minute monthly phone allowance is used.` }, 429)

  const now = Date.now()
  const code = newPairCode()
  const key = await hashPairCode(env.approvalSecret(), code)
  const expiresAt = now + PAIR_CODE_TTL_MS
  // Cross-instance: the hashed code lives in the owner room's server-set LiveKit metadata, so the worker's
  // /api/phone/bind call succeeds on ANY instance (previously: instance memory only → invalid_code).
  const stored = await storePairCode(await livekitRoomStore(), id.userId, s.room, key, expiresAt)
  // E48: ALSO write the durable, atomic store (phone_pair_codes). It is the primary lookup for /api/phone/bind (row-locked
  // attempt counter); LiveKit metadata stays as the fallback when the table/function is not there.
  await pairIssueDurable(id.userId, s.room, key, expiresAt)
  if (!stored) return json({ error: 'no_active_session', message: 'Start a listening session first.' }, 409)
  // Instance cache (same-instance fast path; never the source of truth).
  const codes = rv().phoneCodes
  for (const [k, c] of codes) if (c.expiresAt < now || c.userId === id.userId) codes.delete(k)
  codes.set(key, { userId: id.userId, room: s.room, expiresAt, attempts: 0 })
  logEvent({ evt: 'phone_code_issued', room: s.room })
  void audit(id.userId, 'phone_code_issued', s.room)
  return json({ code, expiresAt, number: env.phoneNumberDisplay() ?? null, maxCallMinutes: minutes, monthUsed, monthCap: TELEPHONY.monthlyInboundMinutesCap })
}

/** Owner revokes any outstanding code (e.g. read aloud to the wrong person). */
async function handleDELETE(req: Request) {
  const id = await getIdentity(req)
  for (const [k, c] of rv().phoneCodes) if (c.userId === id.userId) rv().phoneCodes.delete(k)
  await pairRevokeDurable(id.userId)
  if (env.livekitUrl() && env.livekitKey() && env.livekitSecret()) await revokePairCodes(await livekitRoomStore(), id.userId)
  return json({ ok: true })
}

export const POST = withJsonErrors('phone/pair', handlePOST)
export const DELETE = withJsonErrors('phone/pair', handleDELETE)
