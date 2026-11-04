import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { guestPoolLedger, ledgerFor, projectLedger } from '@/lib/server/state'
import { durableReplay, recordUsage, reserveDurable, settleDurable } from '@/lib/server/durable'
import { logEvent } from '@/lib/server/log'
import { PRICES } from '@/lib/budget'
import { AssemblyError, synthesizeApproved } from '@/lib/server/assemblyai'
import { SpeakRequest } from '@/lib/contracts'
import { ApprovalError, verifyApproval } from '@/lib/approval'
import { codePoints } from '@/lib/hash'
import { withJsonErrors } from '@/lib/server/route'

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

  try {
    await verifyApproval({ secret: env.approvalSecret(), approval, text, expect: { sub: id.userId, roomName: null }, replay: durableReplay(id.userId, approval.textHash) })
  } catch (e) {
    if (e instanceof ApprovalError) return json({ error: e.reason }, e.reason === 'wrong_user' ? 403 : 409)
    if ((e as Error).message === 'replay_store_unavailable') return json({ error: 'replay_store_unavailable' }, 503)
    throw e
  }

  const chars = codePoints(text)
  const user = ledgerFor(id.userId).reserveTts(chars)
  if (!user.ok) return json({ error: 'budget', reason: user.reason }, 429)
  const proj = projectLedger().reserveTts(chars)
  if (!proj.ok) {
    ledgerFor(id.userId).releaseTts(user.id)
    return json({ error: 'budget', reason: proj.reason }, 429)
  }
  // B8: guests also draw from one shared guest pool.
  const pool = id.kind === 'guest' ? guestPoolLedger().reserveTts(chars) : null
  if (pool && !pool.ok) {
    ledgerFor(id.userId).releaseTts(user.id)
    projectLedger().releaseTts(proj.id)
    return json({ error: 'budget', reason: 'guest_pool', message: 'Guest voice allowance is used up for today. Sign in for more.' }, 429)
  }
  const poolId = pool?.ok ? pool.id : undefined
  // Durable, cross-instance transactional reservation (Supabase) — intersects with the in-memory ledgers.
  const durable = await reserveDurable(id.userId, 'assemblyai_tts', chars)
  if (durable && !durable.ok) {
    ledgerFor(id.userId).releaseTts(user.id)
    projectLedger().releaseTts(proj.id)
    if (poolId) guestPoolLedger().releaseTts(poolId)
    return json({ error: 'budget', reason: durable.reason }, 429)
  }
  const durableId = durable?.ok ? durable.id : undefined
  const t0 = Date.now()

  try {
    const r = await synthesizeApproved({
      text,
      voiceId: approval.voiceId,
      language: approval.outputLanguage,
      signal: req.signal,
      clientRequestId: approval.playbackAttemptId,
    })
    ledgerFor(id.userId).commitTts(user.id, r.billedChars)
    projectLedger().commitTts(proj.id, r.billedChars)
    if (poolId) guestPoolLedger().commitTts(poolId, r.billedChars)
    const billed = r.billedChars ?? chars
    await settleDurable(durableId, true, billed, billed * PRICES.ttsPerChar)
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
    ledgerFor(id.userId).releaseTts(user.id)
    projectLedger().releaseTts(proj.id)
    await settleDurable(durableId, false)
    void recordUsage({ userId: id.userId, provider: 'assemblyai', kind: 'tts_http', errorCategory: e instanceof AssemblyError ? e.code : (e as Error).name })
    if (e instanceof AssemblyError) {
      return json({ error: e.code, retryable: e.retryable }, e.status === 402 ? 402 : e.status >= 500 ? 502 : e.status, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {})
    }
    if ((e as Error).name === 'AbortError') return json({ error: 'cancelled' }, 499)
    throw e
  }
}

export const POST = withJsonErrors('speak', handlePOST)
