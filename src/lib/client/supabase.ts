'use client'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { parseAuthSettings, type AuthProviders, type OAuthProvider } from '../auth-providers'

let client: SupabaseClient | null | undefined

/** Browser Supabase client (anon key + RLS). Returns null when Supabase isn't configured (local prototype mode). */
export function getSupabase(): SupabaseClient | null {
  if (client !== undefined) return client
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  client = url && anon ? createClient(url, anon, { auth: { persistSession: true, autoRefreshToken: true, flowType: 'pkce', detectSessionInUrl: true } }) : null
  return client
}

let providersPromise: Promise<AuthProviders> | null = null

/**
 * B8 — discover which sign-in methods the Supabase project ACTUALLY has enabled.
 *
 * Bug: the UI always offered GitHub and Google and navigated straight to Supabase's /authorize
 * endpoint. When a provider is not enabled in the Supabase dashboard, the browser landed on a raw
 * JSON page: {"code":400,"error_code":"validation_failed","msg":"Unsupported provider: provider is not enabled"}.
 * Now we read the public `GET /auth/v1/settings` (anon key, no secrets) and only offer enabled methods.
 */
export function getAuthProviders(): Promise<AuthProviders> {
  if (providersPromise) return providersPromise
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) return Promise.resolve(parseAuthSettings(null))
  providersPromise = fetch(`${url.replace(/\/$/, '')}/auth/v1/settings`, { headers: { apikey: anon } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((j) => {
      const p = parseAuthSettings(j)
      if (!p.reachable) providersPromise = null // retry next time (Supabase paused / offline)
      return p
    })
  return providersPromise
}

export class AuthError extends Error {}

/** Free OAuth sign-in (avoids Supabase default SMTP limits). Refuses providers that are not enabled. */
export async function signInWithOAuth(provider: OAuthProvider) {
  const sb = getSupabase()
  if (!sb) throw new AuthError('Sign-in is not configured on this deployment.')
  const providers = await getAuthProviders()
  if (providers.reachable && !providers.oauth.includes(provider)) {
    throw new AuthError(`${provider === 'github' ? 'GitHub' : 'Google'} sign-in is not enabled for this deployment. Use another option below.`)
  }
  const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo: window.location.origin } })
  if (error) throw new AuthError(error.message)
}

/** Email one-time link (only offered when the Supabase project has email enabled). */
export async function signInWithEmail(email: string) {
  const sb = getSupabase()
  if (!sb) throw new AuthError('Sign-in is not configured on this deployment.')
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin, shouldCreateUser: true } })
  if (error) {
    if (/rate limit|too many/i.test(error.message)) throw new AuthError('Email sign-in is rate limited right now (Supabase default email allows very few messages per hour). Try again later, or continue as guest.')
    throw new AuthError(error.message)
  }
}

/** Supabase anonymous sign-in, only when the project enables it. */
export async function signInAnonymously() {
  const sb = getSupabase()
  if (!sb) throw new AuthError('Sign-in is not configured on this deployment.')
  const { error } = await sb.auth.signInAnonymously()
  if (error) throw new AuthError(error.message)
}

/** OAuth/magic-link failures come back as ?error=…&error_description=… (or in the hash). Read and clear them. */
export function consumeAuthRedirectError(): string | null {
  if (typeof window === 'undefined') return null
  const q = new URLSearchParams(window.location.search)
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const desc = q.get('error_description') ?? h.get('error_description')
  const code = q.get('error') ?? h.get('error')
  if (!desc && !code) return null
  for (const k of ['error', 'error_code', 'error_description']) q.delete(k)
  const qs = q.toString()
  window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
  return (desc ?? code ?? 'Sign-in failed').replace(/\+/g, ' ')
}
