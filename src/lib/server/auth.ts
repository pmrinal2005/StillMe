import 'server-only'
import { cookies } from 'next/headers'
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import { env } from './env'
import { hmacSha256Hex, randomId, sha256Hex, timingSafeEqualHex } from '../hash'
import { EXPECT_ACCOUNT_HEADER, setAuthNote, type AuthNote } from './auth-note'

export interface Identity {
  userId: string
  email?: string
  /** B13: the e-mail was confirmed by Supabase (required for e-mail based operator access). */
  emailVerified?: boolean
  /** B14: this visitor signed in through Supabase ANONYMOUS auth. They are always `kind: 'guest'`. */
  anonymous?: boolean
  /** B14/B19: the underlying Supabase auth user id of an anonymous guest (used only to delete that user). */
  authUserId?: string
  /**
   * 'supabase'   = verified, NON-anonymous Supabase session (OAuth or e-mail).
   * 'local-demo' = signed device cookie, used only when Supabase is not configured.
   * 'guest'      = B8: Supabase IS configured but the visitor has not signed in. Signed device cookie
   *                with much smaller budgets; listening, cloned voices, phone and reconciliation are refused.
   */
  kind: 'supabase' | 'local-demo' | 'guest'
  /** D #33/#34: this guest identity is a FALLBACK for a caller that expected an account (see auth-note.ts). */
  note?: AuthNote
}

const DEMO_COOKIE = 'rv_demo'
const GUEST_COOKIE = 'rv_guest'

/** Guest mode is on unless REVOICE_GUEST_MODE=false. */
export const guestModeEnabled = () => (process.env.REVOICE_GUEST_MODE ?? '').trim().toLowerCase() !== 'false'

async function signedDeviceIdentity(cookieName: string, label: string, prefix: string, kind: Identity['kind']): Promise<Identity> {
  const jar = await cookies()
  const raw = jar.get(cookieName)?.value
  if (raw) {
    const [id, sig] = raw.split('.')
    if (id && sig && timingSafeEqualHex(await hmacSha256Hex(env.approvalSecret(), `${label}:${id}`), sig)) {
      return { userId: `${prefix}-${id}`, kind }
    }
  }
  const id = randomId(12)
  const sig = await hmacSha256Hex(env.approvalSecret(), `${label}:${id}`)
  jar.set(cookieName, `${id}.${sig}`, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 30 })
  return { userId: `${prefix}-${id}`, kind }
}

// ------------------------------------------------------------------------------------------------ token verification
/**
 * D #32 — ONE Supabase client for the whole instance and a short verification cache.
 *
 * Bug: every API call (speak, approve, suggest and the 20 s status poll) built a NEW Supabase client and asked the Auth
 * server to validate the token (`getUser`) — one extra network round-trip on the speech path.
 *
 * Now a verified token is remembered for TOKEN_CACHE_TTL_MS (never past the JWT's own expiry; keyed by SHA-256 of the
 * token so the raw bearer is never stored), concurrent requests share one in-flight check, and if the Auth server is
 * briefly unreachable a token that WAS verified before is still honoured until it expires (stale-if-error) instead of
 * demoting the user to a guest. Cost: a sign-out/revocation is honoured server-side within TOKEN_CACHE_TTL_MS.
 */
export const TOKEN_CACHE_TTL_MS = 30_000
const TOKEN_CACHE_MAX = 500
const EXPIRY_MARGIN_MS = 5_000

interface CacheEntry {
  user: User
  /** Serve without asking Supabase until here. */
  fresh: number
  /** Serve only if Supabase is unreachable, until here (the JWT's own expiry). */
  stale: number
}
const tokenCache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<TokenVerdict>>()
let verifier: { key: string; client: SupabaseClient } | undefined

export type TokenVerdict = { status: 'ok'; user: User } | { status: 'invalid' } | { status: 'unavailable' }

/** `exp` of a JWT in ms (unverified — only used to bound the cache of a token Supabase already accepted). */
export function jwtExpiryMs(token: string): number | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='))
    const exp = Number((JSON.parse(json) as { exp?: unknown }).exp)
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null
  } catch {
    return null
  }
}

/** Transient (Supabase down / rate limited / network) vs. a token Supabase actually rejected. */
export function isRetryableAuthError(e: { name?: string; status?: number } | null | undefined): boolean {
  if (!e) return false
  if (e.name === 'AuthRetryableFetchError') return true
  const s = e.status
  return typeof s === 'number' && (s === 0 || s === 429 || s >= 500)
}

function verifierClient(url: string, anon: string): SupabaseClient {
  const key = `${url}|${anon}`
  if (verifier?.key !== key) verifier = { key, client: createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } }) }
  return verifier.client
}

async function checkWithSupabase(url: string, anon: string, token: string, cacheKey: string): Promise<TokenVerdict> {
  let res: Awaited<ReturnType<SupabaseClient['auth']['getUser']>>
  try {
    res = await verifierClient(url, anon).auth.getUser(token)
  } catch {
    return staleOr(cacheKey)
  }
  if (res.error || !res.data.user) {
    if (isRetryableAuthError(res.error)) return staleOr(cacheKey)
    tokenCache.delete(cacheKey)
    return { status: 'invalid' }
  }
  const now = Date.now()
  const stale = (jwtExpiryMs(token) ?? now + TOKEN_CACHE_TTL_MS) - EXPIRY_MARGIN_MS
  if (stale > now) {
    if (tokenCache.size >= TOKEN_CACHE_MAX) {
      const oldest = tokenCache.keys().next().value
      if (oldest !== undefined) tokenCache.delete(oldest)
    }
    tokenCache.set(cacheKey, { user: res.data.user, fresh: Math.min(now + TOKEN_CACHE_TTL_MS, stale), stale })
  }
  return { status: 'ok', user: res.data.user }
}

function staleOr(cacheKey: string): TokenVerdict {
  const e = tokenCache.get(cacheKey)
  return e && Date.now() < e.stale ? { status: 'ok', user: e.user } : { status: 'unavailable' }
}

export async function verifyAccessToken(url: string, anon: string, token: string): Promise<TokenVerdict> {
  const cacheKey = await sha256Hex(token)
  const hit = tokenCache.get(cacheKey)
  if (hit && Date.now() < hit.fresh) return { status: 'ok', user: hit.user }
  const pending = inflight.get(cacheKey)
  if (pending) return pending
  const p = checkWithSupabase(url, anon, token, cacheKey).finally(() => inflight.delete(cacheKey))
  inflight.set(cacheKey, p)
  return p
}

/** Drop every cached verification of this user (account deletion, tests). */
export function evictAuthCache(userId?: string): void {
  if (!userId) return tokenCache.clear()
  for (const [k, e] of tokenCache) if (e.user.id === userId) tokenCache.delete(k)
}

async function identityFromUser(u: User): Promise<Identity | null> {
  // B14: Supabase ANONYMOUS sign-in is a guest, never a full account. It used to get full budgets, listening,
  // cloned voices, phone and reconciliation. Its pseudo id carries the `guest-` prefix so every guest ledger,
  // the shared guest pool and the durable guest subject (IP-keyed) apply, and it can't collide with a real uuid.
  if (isAnonymousSupabaseUser(u)) {
    if (!guestModeEnabled()) return null
    const pseudo = (await hmacSha256Hex(env.approvalSecret(), `anon-guest:${u.id}`)).slice(0, 24)
    return { userId: `guest-anon-${pseudo}`, kind: 'guest', anonymous: true, authUserId: u.id }
  }
  return { userId: u.id, email: u.email ?? undefined, emailVerified: !!u.email_confirmed_at, kind: 'supabase' }
}

/** Guest fallback that is LABELLED, so the client can recover or tell the user (D #33/#34). */
async function labelledGuest(req: Request, note: AuthNote): Promise<Identity> {
  setAuthNote(req, note)
  return { ...(await signedDeviceIdentity(GUEST_COOKIE, 'guest', 'guest', 'guest')), note }
}

/**
 * Resolve the authenticated caller.
 * - Supabase configured + valid access token (Authorization: Bearer) → that account (verified once per TTL, see above).
 * - Supabase configured + NO token → capped guest. If the browser says it expected an account
 *   (`x-revoice-expect-account`) the guest is labelled `missing_token` instead of silently demoting a signed-in user (D #33).
 * - Supabase configured + INVALID/expired token → capped guest labelled `invalid_token` (D #34: it used to be a hard
 *   401 that broke even guest features until the user signed in again). Auth server unreachable → `auth_unavailable`.
 *   With REVOICE_GUEST_MODE=false there is no guest to fall back to: invalid → null (401), unavailable → throws (503).
 * - Otherwise (local prototype without Supabase) an HMAC-signed device cookie, labelled in the UI.
 */
export async function getIdentity(req: Request): Promise<Identity | null> {
  const url = env.supabaseUrl()
  const anon = env.supabaseAnon()
  if (url && anon) {
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    if (!token) {
      if (!guestModeEnabled()) return null
      return req.headers.get(EXPECT_ACCOUNT_HEADER) === '1' ? labelledGuest(req, 'missing_token') : signedDeviceIdentity(GUEST_COOKIE, 'guest', 'guest', 'guest')
    }
    const v = await verifyAccessToken(url, anon, token)
    if (v.status === 'ok') return identityFromUser(v.user)
    if (!guestModeEnabled()) {
      if (v.status === 'unavailable') throw new Error('auth_unavailable')
      return null
    }
    return labelledGuest(req, v.status === 'invalid' ? 'invalid_token' : 'auth_unavailable')
  }
  return signedDeviceIdentity(DEMO_COOKIE, 'demo', 'demo', 'local-demo')
}

export const GUEST_COOKIE_NAME = GUEST_COOKIE

/** B14: pure check (exported for tests). Supabase marks anonymous users with `is_anonymous` (and provider `anonymous`). */
export function isAnonymousSupabaseUser(u: { is_anonymous?: boolean; app_metadata?: { provider?: string; providers?: string[] } | null }): boolean {
  if (u.is_anonymous === true) return true
  const m = u.app_metadata
  return m?.provider === 'anonymous' || (Array.isArray(m?.providers) && m.providers.length > 0 && m.providers.every((p) => p === 'anonymous'))
}

/**
 * B13: operator = a real (non-anonymous, non-guest) Supabase account that the deployment owner explicitly listed in
 * REVOICE_OPERATOR_IDS, or whose VERIFIED e-mail is in REVOICE_OPERATOR_EMAILS. With both lists empty NOBODY is an
 * operator (fail closed) — "empty list = everyone" let any anonymous account read project spend and post figures.
 */
export function isOperator(id: Identity): boolean {
  if (id.kind !== 'supabase' || id.anonymous) return false
  if (env.operatorIds().includes(id.userId)) return true
  return !!id.email && !!id.emailVerified && env.operatorEmails().includes(id.email.toLowerCase())
}
/** Features that need a real account (cost or consent sensitive). Returns a 401 JSON response for guests. */
export function requireAccount(id: Identity, feature: string): Response | null {
  if (id.kind !== 'guest') return null
  return json({ error: 'account_required', feature, message: `Sign in to use ${feature}. Typing, phrase boards and library voices work as a guest.` }, 401)
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })
}

export function unauthorized() {
  return json({ error: 'unauthorized', message: 'Sign in to continue.' }, 401)
}
