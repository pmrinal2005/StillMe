import 'server-only'
import { cookies } from 'next/headers'
import { createClient } from '@supabase/supabase-js'
import { env } from './env'
import { hmacSha256Hex, randomId, timingSafeEqualHex } from '../hash'

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

/**
 * Resolve the authenticated caller.
 * - If Supabase is configured, a valid Supabase access token (Authorization: Bearer) is REQUIRED.
 * - Otherwise (local prototype without Supabase) we issue an HMAC-signed device cookie so that
 *   approvals are still bound to a stable identity. This mode is labelled in the UI.
 */
export async function getIdentity(req: Request): Promise<Identity | null> {
  const url = env.supabaseUrl()
  const anon = env.supabaseAnon()
  if (url && anon) {
    const auth = req.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    // B8: no session at all → capped guest identity (typing + library-voice speech still work).
    // An INVALID/expired token still returns null (401) so the client refreshes instead of silently downgrading.
    if (!token) return guestModeEnabled() ? signedDeviceIdentity(GUEST_COOKIE, 'guest', 'guest', 'guest') : null
    const sb = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data, error } = await sb.auth.getUser(token)
    if (error || !data.user) return null
    const u = data.user
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
