import 'server-only'

/**
 * Server-only configuration. Importing this module from a client component fails the build
 * (`server-only`), and none of these names carry the NEXT_PUBLIC_ prefix, so Next.js never
 * inlines them into browser bundles. scripts/scan-secrets.mjs double-checks built assets.
 */
function opt(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

let devSecret: string | undefined

export const env = {
  assemblyKey: () => opt('ASSEMBLYAI_API_KEY'),
  assemblyRegion: () => (opt('ASSEMBLYAI_REGION') === 'eu' ? 'eu' : 'us') as 'us' | 'eu',
  groqKey: () => opt('GROQ_API_KEY'),
  groqModel: () => opt('GROQ_MODEL') ?? 'openai/gpt-oss-20b',
  livekitUrl: () => opt('LIVEKIT_URL'),
  livekitKey: () => opt('LIVEKIT_API_KEY'),
  livekitSecret: () => opt('LIVEKIT_API_SECRET'),
  livekitAgentName: () => opt('LIVEKIT_AGENT_NAME') ?? 'revoice-worker',
  supabaseUrl: () => opt('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseAnon: () => opt('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  supabaseService: () => opt('SUPABASE_SERVICE_ROLE_KEY'),
  allowBrowserStt: () => opt('REVOICE_ALLOW_BROWSER_STT') === 'true',
  /** HMAC secret for approvals/invites. Falls back to a per-process random secret in dev only. */
  approvalSecret: (): string => {
    const s = opt('REVOICE_APPROVAL_SECRET')
    if (s) return s
    if (process.env.NODE_ENV === 'production' && opt('REVOICE_REQUIRE_SECRET') === 'true') {
      throw new Error('REVOICE_APPROVAL_SECRET is required')
    }
    if (!devSecret) {
      const a = new Uint8Array(32)
      crypto.getRandomValues(a)
      devSecret = Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
    }
    return devSecret
  },
}

export function providerStatus() {
  return {
    assemblyai: !!env.assemblyKey(),
    groq: !!env.groqKey(),
    livekit: !!(env.livekitUrl() && env.livekitKey() && env.livekitSecret()),
    supabase: !!(env.supabaseUrl() && env.supabaseAnon()),
    durableStore: !!(env.supabaseUrl() && env.supabaseService()),
    browserStt: env.allowBrowserStt() && !!env.assemblyKey(),
    approvalSecretConfigured: !!process.env.REVOICE_APPROVAL_SECRET,
    region: env.assemblyRegion(),
    groqModel: env.groqModel(),
  }
}
