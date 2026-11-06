import 'server-only'
import { env } from './env'
import { STT_MODEL, TTS_MODEL, type OutputLanguage } from '../contracts'

/**
 * AssemblyAI BYOK helpers (server-side only).
 *  - HTTP TTS fallback: POST https://tts.{us|eu}.assemblyai.com/v1/speech  (≤5,000 code points)
 *  - Temporary streaming STT token (trusted private demo only)
 *  - Temporary TTS token minting is intentionally NOT exposed: token lifetime is not a
 *    character quota or a voice authorization.
 */

export const ttsBase = () => `https://tts.${env.assemblyRegion()}.assemblyai.com`
export const sttWsBase = () => (env.assemblyRegion() === 'eu' ? 'wss://streaming.eu.assemblyai.com' : 'wss://streaming.assemblyai.com')
export const sttHttpBase = () => (env.assemblyRegion() === 'eu' ? 'https://streaming.eu.assemblyai.com' : 'https://streaming.assemblyai.com')

export interface TtsResult {
  body: ReadableStream<Uint8Array>
  headers: Headers
  billedChars?: number
  /** D #38: provider-reported voice consent expiry in EPOCH MILLISECONDS (the provider header is in seconds). */
  voiceExpiresAt?: number
}

export class AssemblyError extends Error {
  constructor(public status: number, public code: string, public retryable: boolean, public retryAfter?: number, message?: string) {
    super(message ?? code)
  }
}

/** Provider error codes that mean "the provider rejected OUR server credentials" (never the visitor's login). */
const PROVIDER_AUTH_CODES = new Set(['unauthorized', 'unauthenticated', 'forbidden', 'invalid_api_key', 'invalid_token', 'authentication_failed', 'authentication_error', 'permission_denied'])

/** D #37: a provider-supplied error code is only ever shown to the user if it cannot be mistaken for a sign-in problem. */
export function sanitizeProviderCode(code: string | undefined | null, fallback = 'upstream_error'): string {
  const c = (code ?? '').toString().trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 48)
  if (!c || PROVIDER_AUTH_CODES.has(c)) return fallback
  return c
}

/**
 * D #37 — translate an AssemblyAI failure into OUR response.
 *
 * Bug: /api/speak passed the provider's own status/code straight through. A bad or expired ASSEMBLYAI_API_KEY reached the
 * browser as HTTP 401 `unauthorized`, which the UI (and the account layer) read as "you are signed out" — the visitor was
 * told to sign in for a server-side configuration problem. A provider 429 with an arbitrary code was likewise treated as the
 * app's own daily-budget pause.
 *
 * Now: provider 401/403 (or an auth-shaped code) → 502 `speech_provider_auth` (a server problem, retrying will not help);
 * 402 → 402 `provider_credit_exhausted`; 429 → 429 `rate_limited` (+ Retry-After); bad voice/text → 422 with a safe code;
 * everything else → 502. Only OUR routes ever emit 401 (`unauthorized` / `account_required`).
 */
export function providerFailure(e: AssemblyError): { status: number; body: { error: string; retryable: boolean; message?: string }; retryAfter?: number } {
  const authShaped = e.status === 401 || e.status === 403 || PROVIDER_AUTH_CODES.has((e.code ?? '').toLowerCase())
  if (authShaped) {
    return { status: 502, body: { error: 'speech_provider_auth', retryable: false, message: 'The speech provider rejected this server\'s credentials. Nothing was spoken. This is a server configuration problem, not a sign-in problem.' } }
  }
  if (e.status === 402) return { status: 402, body: { error: 'provider_credit_exhausted', retryable: false, message: 'The speech provider reports no remaining credit. Use the device voice or large text.' } }
  if (e.status === 429) return { status: 429, body: { error: 'rate_limited', retryable: true }, retryAfter: e.retryAfter }
  if (e.status === 400 || e.status === 404 || e.status === 413 || e.status === 422) {
    return { status: 422, body: { error: sanitizeProviderCode(e.code, 'invalid_speech_request'), retryable: false } }
  }
  if (e.status === 0 || e.status >= 500 || e.status >= 400) {
    return { status: 502, body: { error: e.status >= 500 ? sanitizeProviderCode(e.code, 'upstream_error') : 'upstream_error', retryable: e.retryable } }
  }
  return { status: 502, body: { error: 'upstream_error', retryable: e.retryable } }
}

/**
 * D #37 (follow-up, found by the live check against the deployed site) — a NETWORK-level failure reaching the provider
 * (DNS, reset, TLS, `fetch failed`) is not an AssemblyError, so /api/speak answered it with a generic 500 `internal_error`
 * and the visitor was told "something went wrong on the server". It is a transient, retryable upstream problem: 502.
 */
export function isNetworkFailure(e: unknown): boolean {
  if (!(e instanceof Error) || e.name === 'AbortError') return false
  if (e instanceof TypeError) return true // undici: "fetch failed"
  const c = (e as { code?: unknown; cause?: { code?: unknown } }).code ?? (e as { cause?: { code?: unknown } }).cause?.code
  return typeof c === 'string' && /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR_.*)$/.test(c)
}

/** The provider reports expiry as epoch SECONDS (X-TTS-Voice-Expires-At). Returns epoch ms, or undefined if absent/implausible. */
export function parseVoiceExpiryMs(header: string | null | undefined): number | undefined {
  const n = Number(header)
  if (!Number.isFinite(n) || n <= 0) return undefined
  // Seconds today (~1.8e9). Tolerate a provider that already sends milliseconds (>= 1e11) instead of multiplying again.
  return n >= 1e11 ? Math.round(n) : Math.round(n * 1000)
}

/**
 * Synthesize EXACT approved text. Called only after verifyApproval().
 * Streams raw 16-bit PCM (24 kHz mono) so the browser can start playback on first bytes.
 */
export async function synthesizeApproved(opts: {
  text: string
  voiceId: string
  language: OutputLanguage
  encoding?: 'pcm_s16le' | 'mp3'
  sampleRate?: number
  signal?: AbortSignal
  clientRequestId?: string
}): Promise<TtsResult> {
  const key = env.assemblyKey()
  if (!key) throw new AssemblyError(503, 'not_configured', false, undefined, 'ASSEMBLYAI_API_KEY not configured')
  const res = await fetch(`${ttsBase()}/v1/speech`, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      authorization: key,
      'content-type': 'application/json',
      ...(opts.clientRequestId ? { 'x-client-request-id': opts.clientRequestId } : {}),
    },
    body: JSON.stringify({
      text: opts.text,
      voice_id: opts.voiceId,
      language: opts.language,
      model_id: TTS_MODEL,
      encoding: opts.encoding ?? 'pcm_s16le',
      sample_rate: opts.sampleRate ?? 24000,
      // NEVER set extend_biometric_consent here: renewal requires a separate, affirmative user action.
    }),
  })
  if (!res.ok || !res.body) {
    let code = 'upstream_error'
    let retryable = res.status >= 500 || res.status === 429
    try {
      const j = await res.json()
      code = j.code ?? code
      retryable = j.retryable ?? retryable
    } catch {}
    const ra = Number(res.headers.get('retry-after'))
    throw new AssemblyError(res.status, code, retryable, Number.isFinite(ra) ? ra : undefined)
  }
  const billed = Number(res.headers.get('x-tts-billed-characters'))
  return {
    body: res.body,
    headers: res.headers,
    billedChars: Number.isFinite(billed) ? billed : undefined,
    voiceExpiresAt: parseVoiceExpiryMs(res.headers.get('x-tts-voice-expires-at')), // D #38: seconds → ms
  }
}

/** Short-lived streaming STT token for browser-direct mode (trusted private demo only). */
export async function mintSttToken(maxSessionSeconds: number): Promise<string> {
  const key = env.assemblyKey()
  if (!key) throw new AssemblyError(503, 'not_configured', false)
  const u = new URL(`${sttHttpBase()}/v3/token`)
  u.searchParams.set('expires_in_seconds', '60')
  u.searchParams.set('max_session_duration_seconds', String(Math.max(60, Math.min(maxSessionSeconds, 1200))))
  const res = await fetch(u, { headers: { authorization: key } })
  if (!res.ok) throw new AssemblyError(res.status, 'token_error', res.status >= 500)
  const j = (await res.json()) as { token?: string }
  if (!j.token) throw new AssemblyError(502, 'token_error', true)
  return j.token
}

/** Build the browser STT WebSocket URL. The model is selected explicitly. */
export function sttWsUrl(opts: { token: string; sampleRate: number; languageCodes?: string[]; keyterms?: string[]; prompt?: string }) {
  const u = new URL(`${sttWsBase()}/v3/ws`)
  u.searchParams.set('token', opts.token)
  u.searchParams.set('speech_model', STT_MODEL)
  u.searchParams.set('sample_rate', String(opts.sampleRate))
  u.searchParams.set('encoding', 'pcm_s16le')
  u.searchParams.set('format_turns', 'true')
  u.searchParams.set('mode', 'balanced')
  if (opts.languageCodes?.length) u.searchParams.set('language_codes', JSON.stringify(opts.languageCodes))
  if (opts.keyterms?.length) u.searchParams.set('keyterms_prompt', JSON.stringify(opts.keyterms.slice(0, 50)))
  if (opts.prompt) u.searchParams.set('prompt', opts.prompt.slice(0, 500))
  return u.toString()
}
