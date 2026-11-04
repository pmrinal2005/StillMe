import 'server-only'
import { cookies } from 'next/headers'
import { createClient } from '@supabase/supabase-js'
import { env } from './env'
import { hmacSha256Hex, randomId, timingSafeEqualHex } from '../hash'

export interface Identity {
  userId: string
  email?: string
  /**
   * 'supabase'   = verified Supabase session (OAuth, email link or anonymous).
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
    return { userId: data.user.id, email: data.user.email ?? undefined, kind: 'supabase' }
  }
  return signedDeviceIdentity(DEMO_COOKIE, 'demo', 'demo', 'local-demo')
}

export const GUEST_COOKIE_NAME = GUEST_COOKIE

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
