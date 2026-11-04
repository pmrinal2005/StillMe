/**
 * Pure helpers for sign-in method discovery (shared by client + tests).
 * Input is the public Supabase `GET /auth/v1/settings` response.
 */
export type OAuthProvider = 'github' | 'google'
export const OAUTH_PROVIDERS: OAuthProvider[] = ['github', 'google']

export interface AuthProviders {
  /** false when the settings endpoint could not be read (Supabase paused / offline / not configured) */
  reachable: boolean
  oauth: OAuthProvider[]
  email: boolean
  anonymous: boolean
  signupDisabled: boolean
}

export function parseAuthSettings(j: unknown): AuthProviders {
  const ext = (j && typeof j === 'object' ? (j as { external?: Record<string, unknown> }).external : undefined) ?? null
  if (!ext || typeof ext !== 'object') return { reachable: false, oauth: [], email: false, anonymous: false, signupDisabled: false }
  return {
    reachable: true,
    oauth: OAUTH_PROVIDERS.filter((p) => ext[p] === true),
    email: ext.email === true,
    anonymous: ext.anonymous_users === true,
    signupDisabled: (j as { disable_signup?: unknown }).disable_signup === true,
  }
}
