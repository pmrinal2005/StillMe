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
  voiceExpiresAt?: number
}

export class AssemblyError extends Error {
  constructor(public status: number, public code: string, public retryable: boolean, public retryAfter?: number, message?: string) {
    super(message ?? code)
  }
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
  const exp = Number(res.headers.get('x-tts-voice-expires-at'))
  return {
    body: res.body,
    headers: res.headers,
    billedChars: Number.isFinite(billed) ? billed : undefined,
    voiceExpiresAt: Number.isFinite(exp) && exp > 0 ? exp : undefined,
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
