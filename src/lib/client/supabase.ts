'use client'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null | undefined

/** Browser Supabase client (anon key + RLS). Returns null when Supabase isn't configured (local prototype mode). */
export function getSupabase(): SupabaseClient | null {
  if (client !== undefined) return client
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  client = url && anon ? createClient(url, anon, { auth: { persistSession: true, autoRefreshToken: true, flowType: 'pkce' } }) : null
  return client
}

/** Free OAuth sign-in (avoids Supabase default SMTP limits). */
export async function signInWithOAuth(provider: 'github' | 'google') {
  const sb = getSupabase()
  if (!sb) return
  await sb.auth.signInWithOAuth({ provider, options: { redirectTo: window.location.origin } })
}
