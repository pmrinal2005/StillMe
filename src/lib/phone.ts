/**
 * Inbound phone bridge helpers (pure, isomorphic). Mirrors worker/revoice_worker/phone.py.
 *
 * - Pair codes are 6 digits, single use, expire after PAIR_CODE_TTL_MS, and bind to ONE active
 *   authenticated owner session. Caller ID is never sufficient on its own.
 * - Application cap: 40 inbound minutes/month (of the 50 included), max 15 minutes per call.
 * - Outbound PSTN, paid carriers and emergency calling stay disabled (see features.ts).
 */
import { TELEPHONY } from './features'
import { hmacSha256Hex, timingSafeEqualHex } from './hash'

export const PAIR_CODE_TTL_MS = 5 * 60_000
export const PAIR_CODE_DIGITS = 6
export const BINDING_TTL_MS = 2 * 60_000
export const MAX_BIND_ATTEMPTS_PER_CODE = 3

/** Must match binding_string() in worker/revoice_worker/phone.py (integer minutes only). */
export function phoneBindingString(room: string, identity: string, expMs: number, maxMinutes: number): string {
  return `phone:${room}:${identity}:${expMs}:${maxMinutes}`
}

export async function signPhoneBinding(secret: string, room: string, identity: string, expMs: number, maxMinutes: number): Promise<string> {
  const mm = Math.floor(maxMinutes)
  const sig = await hmacSha256Hex(secret, phoneBindingString(room, identity, expMs, mm))
  // Same key order / compact separators as the Python json.dumps(..., separators=(",", ":")).
  return JSON.stringify({ room, identity, exp: expMs, maxMinutes: mm, sig })
}

export async function verifyPhoneBinding(secret: string, raw: string, expect: { room: string; identity: string }, now = Date.now()): Promise<number | null> {
  try {
    const b = JSON.parse(raw) as { room: string; identity: string; exp: number; maxMinutes: number; sig: string }
    if (b.room !== expect.room || b.identity !== expect.identity || now > b.exp) return null
    if (!(b.maxMinutes > 0 && b.maxMinutes <= TELEPHONY.maxCallMinutes)) return null
    const expected = await hmacSha256Hex(secret, phoneBindingString(b.room, b.identity, b.exp, b.maxMinutes))
    return timingSafeEqualHex(expected, b.sig) ? b.maxMinutes : null
  } catch {
    return null
  }
}

/** Integer minutes the next call may use (0 = refuse). Mirrors allowed_call_minutes(). */
export function allowedCallMinutes(usedThisMonth: number, cap: number = TELEPHONY.monthlyInboundMinutesCap, perCall: number = TELEPHONY.maxCallMinutes): number {
  return Math.max(0, Math.floor(Math.min(perCall, cap - usedThisMonth)))
}

export function newPairCode(): string {
  const a = new Uint32Array(1)
  crypto.getRandomValues(a)
  return String(a[0] % 10 ** PAIR_CODE_DIGITS).padStart(PAIR_CODE_DIGITS, '0')
}

export const isPairCode = (s: string) => new RegExp(`^\\d{${PAIR_CODE_DIGITS}}$`).test(s)

/** Hash pair codes before storing (they are short; never persist them in clear). */
export async function hashPairCode(secret: string, code: string): Promise<string> {
  return hmacSha256Hex(secret, `paircode:${code}`)
}
