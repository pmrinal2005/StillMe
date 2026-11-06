import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { durableReplay, recordUsage } from '@/lib/server/durable'
import { reserveTtsSpend } from '@/lib/server/spend'
import { logEvent } from '@/lib/server/log'
import { PRICES } from '@/lib/budget'
import { AssemblyError, providerFailure, synthesizeApproved } from '@/lib/server/assemblyai'
import { SpeakRequest } from '@/lib/contracts'
import { ApprovalError, verifyApproval } from '@/lib/approval'
import { codePoints } from '@/lib/hash'
import { withJsonErrors } from '@/lib/server/route'
import { authorizeVoice, persistProviderExpiry, VoiceRegistryError, voiceStoreFor } from '@/lib/server/voice-registry'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Direct-provider path (also the fallback when LiveKit is unavailable or capped):
 * verified approval → budget reservation → AssemblyAI HTTP TTS → streamed raw PCM.
 *
 * Stop: the client aborts the fetch; req.signal propagates and cancels upstream synthesis.
 * Late bytes from a cancelled attempt are discarded client-side by playbackAttemptId.
 */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  const parsed = SpeakRequest.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request' }, 400)
  const { approval, text } = parsed.data

  // B11/B12: re-check the voice at SPEAK time (a clone may have been revoked or expired since the approval was
  // signed; approvals live up to 60 s). A signed approval is not a licence to use somebody else's/expired voice.
  const store = voiceStoreFor(id.userId)
  let clonedProfile: import('@/lib/voices').ClonedVoiceProfile | null = null
  try {
    const va = await authorizeVoice(store, id, approval.voiceId, env.assemblyRegion())
    if (!va.ok) return json({ error: 'voice_not_authorized', reason: va.reason }, 403)
    if (va.kind === 'cloned') clonedProfile = va.profile
  } catch (e) {
    if (e instanceof VoiceRegistryError) return json({ error: e.code }, e.status)
    throw e
  }

  try {
    await verifyApproval({ secret: env.approvalSecret(), approval, text, expect: { sub: id.userId, roomName: null }, replay: durableReplay(id.userId, approval.textHash) })
  } catch (e) {
    if (e instanceof ApprovalError) return json({ error: e.reason }, e.reason === 'wrong_user' ? 403 : 409)
    if ((e as Error).message === 'replay_store_unavailable') return json({ error: 'replay_store_unavailable' }, 503)
    throw e
  }

  const chars = codePoints(text)
  // A5/A8: one reservation across user ∩ project ∩ guest pool ∩ DURABLE (subject + guest pool + project).
  // Every release path below releases ALL of them (the guest pool reservation leaked before).
  const spend = await reserveTtsSpend(id, req, chars)
  if (!spend.ok) return json(spend.body, spend.status)
  const t0 = Date.now()

  try {
    const r = await synthesizeApproved({
      text,
      voiceId: approval.voiceId,
      language: approval.outputLanguage,
      signal: req.signal,
      clientRequestId: approval.playbackAttemptId,
    })
    const billed = r.billedChars ?? chars
    await spend.commit(billed)
    // D #38: remember the provider's real consent expiry (best effort — never delays or fails the audio).
    if (clonedProfile && r.voiceExpiresAt) void persistProviderExpiry(store, id.userId, clonedProfile, r.voiceExpiresAt).catch(() => undefined)
    // Content-free usage log (no text).
    logEvent({ evt: 'tts', attempt: approval.playbackAttemptId, chars, billed: r.billedChars, req: r.headers.get('x-request-id'), ms: Date.now() - t0 })
    void recordUsage({ userId: id.userId, provider: 'assemblyai', kind: 'tts_http', units: billed, estUsd: billed * PRICES.ttsPerChar, requestId: r.headers.get('x-request-id'), durationMs: Date.now() - t0 })
    return new Response(r.body, {
      headers: {
        'content-type': 'audio/pcm',
        'cache-control': 'no-store',
        'x-revoice-sample-rate': r.headers.get('x-tts-sample-rate') ?? '24000',
        'x-revoice-attempt': approval.playbackAttemptId,
        ...(r.voiceExpiresAt ? { 'x-revoice-voice-expires-at': String(r.voiceExpiresAt) } : {}),
      },
    })
  } catch (e) {
    // Errors before first audio are not billed by AssemblyAI → refund reservations.
    await spend.release() // A8: user + project + guest pool + durable
    void recordUsage({ userId: id.userId, provider: 'assemblyai', kind: 'tts_http', errorCategory: e instanceof AssemblyError ? e.code : (e as Error).name })
    if (e instanceof AssemblyError) {
      // D #37: OUR error vocabulary — a provider 401 (bad server key) must never reach the browser as "sign in".
      const f = providerFailure(e)
      logEvent({ evt: 'tts', status: e.status, code: f.body.error })
      return json(f.body, f.status, f.retryAfter ? { 'retry-after': String(f.retryAfter) } : {})
    }
    if ((e as Error).name === 'AbortError') return json({ error: 'cancelled' }, 499)
    throw e
  }
}

export const POST = withJsonErrors('speak', handlePOST)
