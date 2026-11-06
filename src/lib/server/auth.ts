import 'server-only'
import { cookies } from 'next/headers'
import { env } from './env'
import { hmacSha256Hex, randomId, sha256Hex, timingSafeEqualHex } from '../hash'
import { count, hit } from './rate-limit'

/**
 * NO SIGN-IN.
 *
 * ReVOICE has no accounts, no passwords, no OAuth, no e-mail links and no anonymous-auth provider. Every browser is a
 * DEVICE: the first API call mints a random device id and stores it in an HMAC-signed, HttpOnly cookie. Server-side
 * that id is mapped to a deterministic UUID (`userId`), which is the key for budgets, the cloned-voice registry, listening
 * sessions and the phone bridge. Nothing here talks to an identity provider.
 *
 * Properties that matter:
 *  - The cookie is signed with the same approval secret as everything else (see env.ts, B2), so every serverless instance
 *    and the Python worker agree on it. A forged or edited cookie is simply replaced by a fresh device identity.
 *  - A device cannot raise its own limits: per-device ledgers, project-wide ledgers and a per-IP durable subject (spend.ts)
 *    all apply, so clearing cookies does not mint a new allowance.
 *  - A cloned voice is bound to ONE device identity. Because there are no accounts, the device can export a LINK CODE
 *    (`POST /api/device`) and restore it on another browser, or after clearing cookies, to keep the same identity.
 *  - Operator-only views (spend reconciliation, project budget) use a separate secret, `REVOICE_OPERATOR_TOKEN`. Unset
 *    means nobody is an operator (fail closed).
 */
export interface Identity {
  /** Deterministic UUID derived from the device id (a real uuid, so durable tables and RPCs keep working). */
  userId: string
  /** Random device id (the cookie payload). Never sent to other users, rooms or providers. */
  deviceId: string
}

export const DEVICE_COOKIE = 'rv_device'
/** One year. Browsers cap cookie lifetime (Chrome: 400 days), so this is "as long as the browser allows". */
export const DEVICE_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365
const SIG_LABEL = 'device-cookie'
const UUID_LABEL = 'device-user'
const DEVICE_ID_RE = /^[0-9a-f]{32}$/

/** Signature over a device id. */
export async function signDeviceId(deviceId: string): Promise<string> {
  return hmacSha256Hex(env.approvalSecret(), `${SIG_LABEL}:${deviceId}`)
}

/** `<id>.<sig>` — the cookie value AND the link code a user can move to another browser. */
export async function deviceKeyFor(deviceId: string): Promise<string> {
  return `${deviceId}.${await signDeviceId(deviceId)}`
}

/** Verify a `<id>.<sig>` key; returns the device id or null. */
export async function parseDeviceKey(raw: string | null | undefined): Promise<string | null> {
  if (!raw) return null
  const [id, sig, extra] = raw.trim().split('.')
  if (extra !== undefined || !id || !sig || !DEVICE_ID_RE.test(id)) return null
  return timingSafeEqualHex(await signDeviceId(id), sig) ? id : null
}

/** Device id → RFC 4122-shaped UUID (v4 bits), deterministic for a given secret. */
export async function userIdForDevice(deviceId: string): Promise<string> {
  const h = (await hmacSha256Hex(env.approvalSecret(), `${UUID_LABEL}:${deviceId}`)).slice(0, 32).split('')
  h[12] = '4'
  h[16] = '89ab'[parseInt(h[16], 16) & 3]
  const s = h.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

export async function identityFromDeviceId(deviceId: string): Promise<Identity> {
  return { userId: await userIdForDevice(deviceId), deviceId }
}

export const deviceCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: DEVICE_COOKIE_MAX_AGE_S,
})

/**
 * Resolve the caller. Always succeeds: a valid cookie keeps its device identity; a missing or invalid one gets a fresh
 * identity (and a new cookie). `req` is accepted for symmetry with the route handlers and for per-request context.
 */
export async function getIdentity(_req?: Request): Promise<Identity> {
  const jar = await cookies()
  const existing = await parseDeviceKey(jar.get(DEVICE_COOKIE)?.value)
  if (existing) return identityFromDeviceId(existing)
  const deviceId = randomId(16)
  jar.set(DEVICE_COOKIE, await deviceKeyFor(deviceId), deviceCookieOptions())
  return identityFromDeviceId(deviceId)
}

// ------------------------------------------------------------------------------------------------ operator
export const OPERATOR_HEADER = 'x-revoice-operator'

/** Constant-time comparison of two secrets of any length (both are hashed first). */
export async function secretsMatch(given: string, expected: string): Promise<boolean> {
  return timingSafeEqualHex(await sha256Hex(given), await sha256Hex(expected))
}

/**
 * Operator = the caller presents `REVOICE_OPERATOR_TOKEN` in `x-revoice-operator`. FAIL CLOSED: with no token configured
 * nobody is an operator. Wrong attempts are counted per client and refused outright after a few, so the token cannot be
 * guessed online.
 */
export async function isOperator(req: Request): Promise<boolean> {
  const expected = env.operatorToken()
  if (!expected) return false
  const given = (req.headers.get(OPERATOR_HEADER) ?? '').trim()
  if (!given) return false
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown'
  const key = `operator-fail:${await sha256Hex(ip)}`
  const WINDOW = 10 * 60_000
  const MAX_FAILS = 8
  if (count(key, WINDOW) >= MAX_FAILS) return false // locked out: even the right token is refused until the window clears
  if (await secretsMatch(given, expected)) return true
  hit(key, WINDOW)
  return false
}

/** Optional passcode that gates REGISTERING a cloned voice (REVOICE_CLONE_PASSCODE). Unset = anyone may register. */
export const CLONE_PASSCODE_HEADER = 'x-revoice-clone-passcode'
export async function mayRegisterClone(req: Request): Promise<boolean> {
  const expected = env.clonePasscode()
  if (!expected) return true
  const given = (req.headers.get(CLONE_PASSCODE_HEADER) ?? '').trim()
  return !!given && (await secretsMatch(given, expected))
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })
}
