import 'server-only'
import { cookies } from 'next/headers'
import { createClient } from '@supabase/supabase-js'
import { env } from './env'
import { hmacSha256Hex, randomId, timingSafeEqualHex } from '../hash'

export interface Identity {
  userId: string
  email?: string
  /** 'supabase' = verified OAuth session; 'local-demo' = signed device cookie, used only when Supabase is not configured. */
  kind: 'supabase' | 'local-demo'
}

const DEMO_COOKIE = 'rv_demo'

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
    if (!token) return null
    const sb = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data, error } = await sb.auth.getUser(token)
    if (error || !data.user) return null
    return { userId: data.user.id, email: data.user.email ?? undefined, kind: 'supabase' }
  }
  const jar = await cookies()
  const raw = jar.get(DEMO_COOKIE)?.value
  if (raw) {
    const [id, sig] = raw.split('.')
    if (id && sig && timingSafeEqualHex(await hmacSha256Hex(env.approvalSecret(), `demo:${id}`), sig)) {
      return { userId: `demo-${id}`, kind: 'local-demo' }
    }
  }
  const id = randomId(12)
  const sig = await hmacSha256Hex(env.approvalSecret(), `demo:${id}`)
  jar.set(DEMO_COOKIE, `${id}.${sig}`, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 30 })
  return { userId: `demo-${id}`, kind: 'local-demo' }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })
}

export function unauthorized() {
  return json({ error: 'unauthorized', message: 'Sign in to continue.' }, 401)
}
