import 'server-only'
import { createHmac } from 'node:crypto'

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

/** Domain-separation label for the derived secret. Changing it invalidates all outstanding approvals. */
export const APPROVAL_SECRET_LABEL = 'revoice/approval-secret/v1'
/** Provider secrets the derived approval secret may be keyed from, in priority order (worker uses the same order). */
export const APPROVAL_SECRET_SOURCES = ['LIVEKIT_API_SECRET', 'ASSEMBLYAI_API_KEY'] as const
export type ApprovalSecretSource = 'explicit' | `derived:${(typeof APPROVAL_SECRET_SOURCES)[number]}` | 'dev-random' | 'missing'

/** Pure derivation (exported for tests; must equal worker `derive_approval_secret`). */
export function deriveApprovalSecret(providerSecret: string): string {
  return createHmac('sha256', providerSecret).update(APPROVAL_SECRET_LABEL).digest('hex')
}

function resolveApprovalSecret(): { secret: string; source: ApprovalSecretSource } {
  const explicit = opt('REVOICE_APPROVAL_SECRET')
  if (explicit) return { secret: explicit, source: 'explicit' }
  for (const name of APPROVAL_SECRET_SOURCES) {
    const v = opt(name)
    if (v) return { secret: deriveApprovalSecret(v), source: `derived:${name}` }
  }
  if (process.env.NODE_ENV === 'production') {
    // Never fall back to a per-instance random secret in production (that was bug B2).
    throw new Error('approval_secret_unavailable: set REVOICE_APPROVAL_SECRET (or LIVEKIT_API_SECRET / ASSEMBLYAI_API_KEY)')
  }
  if (!devSecret) {
    const a = new Uint8Array(32)
    crypto.getRandomValues(a)
    devSecret = Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  return { secret: devSecret, source: 'dev-random' }
}

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
  /** Included US number only — the owner enables this ONLY if activation requires no new spending. */
  phoneInboundEnabled: () => opt('REVOICE_PHONE_INBOUND_ENABLED') === 'true',
  phoneNumberDisplay: () => opt('REVOICE_PHONE_NUMBER_DISPLAY'),
  /**
   * B13: operators (spend reconciliation + operator status detail). FAIL CLOSED: when BOTH lists are empty
   * nobody is an operator. (It used to mean "every account", including anonymous Supabase sign-ins.)
   * Comma-separated Supabase user ids and/or VERIFIED e-mail addresses of real (non-anonymous) accounts.
   */
  operatorIds: () => (opt('REVOICE_OPERATOR_IDS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  operatorEmails: () => (opt('REVOICE_OPERATOR_EMAILS') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  /**
   * B11: optional allowlist of who may BIND a cloned voice id to their account (user ids or verified e-mails).
   * Empty = any signed-in, non-guest account may register (the AssemblyAI account is shared, so ownership is
   * "first verified claim"; set this to let only the deployment owner decide who can claim a clone).
   */
  cloneRegistrants: () => (opt('REVOICE_CLONE_REGISTRANTS') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  /**
   * HMAC secret for approvals, invites, demo identity, session tickets and worker→app auth.
   *
   * B2 fix: this MUST be identical on every serverless instance AND in the Python worker.
   * The old code invented a per-instance random secret whenever REVOICE_APPROVAL_SECRET was
   * unset, so approvals/invites/demo cookies signed on instance A failed on instance B.
   * Resolution order (mirrored byte-for-byte in worker/revoice_worker/config.py):
   *   1. REVOICE_APPROVAL_SECRET (recommended — set it on Vercel AND LiveKit Cloud)
   *   2. HMAC-SHA256(key=<first stable provider secret>, msg=APPROVAL_SECRET_LABEL), using
   *      LIVEKIT_API_SECRET, then ASSEMBLYAI_API_KEY — both are required by the worker too.
   *   3. Development only: a per-process random secret. In production we fail closed.
   */
  approvalSecret: (): string => resolveApprovalSecret().secret,
  approvalSecretSource: (): ApprovalSecretSource => {
    try {
      return resolveApprovalSecret().source
    } catch {
      return 'missing'
    }
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
    phoneInbound: env.phoneInboundEnabled() && !!(env.livekitUrl() && env.livekitKey() && env.livekitSecret()),
    /** true when every instance (and the worker) resolves the SAME secret — explicit or derived. */
    approvalSecretConfigured: ['explicit', 'derived:LIVEKIT_API_SECRET', 'derived:ASSEMBLYAI_API_KEY'].includes(env.approvalSecretSource()),
    approvalSecretSource: env.approvalSecretSource(),
    region: env.assemblyRegion(),
    groqModel: env.groqModel(),
  }
}
