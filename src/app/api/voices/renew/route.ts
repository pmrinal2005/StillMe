import { z } from 'zod'
import { getIdentity, json, requireAccount, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { ttsBase } from '@/lib/server/assemblyai'
import { reserveTtsSpend } from '@/lib/server/spend'
import { OutputLanguage, TTS_MODEL } from '@/lib/contracts'
import { codePoints } from '@/lib/hash'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

const Body = z.object({
  voiceId: z.string().min(1).max(128),
  /** The owner must type this exact phrase — consent is never silently extended. */
  affirmation: z.literal('I consent to renew use of my synthetic voice'),
  speakerIsOwner: z.literal(true),
  outputLanguage: OutputLanguage.default('english'),
})

/**
 * Affirmative consent renewal through the documented route: a speech request by the owning
 * account with extend_biometric_consent=true. Uses a minimal 2-character text (billed) and
 * buffers the response so the renewed expiry is reported in X-TTS-Voice-Expires-At.
 */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  { const gate = requireAccount(id, 'cloned voices'); if (gate) return gate }
  const key = env.assemblyKey()
  if (!key) return json({ error: 'assemblyai_not_configured' }, 503)
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'affirmation_required' }, 400)
  // A9: renewal is billed speech → reserve against user ∩ project ∩ durable (was: per-instance user ledger only).
  const text = 'Ok'
  const spend = await reserveTtsSpend(id, req, codePoints(text))
  if (!spend.ok) return json(spend.body, spend.status)
  let res: Response
  try {
    res = await fetch(`${ttsBase()}/v1/speech`, {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/json' },
      // A9: model + language are explicit (same as /api/speak) so renewal never falls back to provider defaults.
      body: JSON.stringify({ text, voice_id: parsed.data.voiceId, model_id: TTS_MODEL, language: parsed.data.outputLanguage, stream: false, extend_biometric_consent: true, encoding: 'mp3' }),
    })
  } catch (e) {
    await spend.release()
    throw e
  }
  if (!res.ok) {
    await spend.release() // errors are not billed
    const j = await res.json().catch(() => ({}))
    return json({ error: j.code ?? 'renew_failed', message: j.message }, res.status === 422 ? 422 : 502)
  }
  await res.arrayBuffer()
  await spend.commit(Number(res.headers.get('x-tts-billed-characters')) || codePoints(text))
  const exp = Number(res.headers.get('x-tts-voice-expires-at'))
  console.log(JSON.stringify({ evt: 'consent_renewed', voice: parsed.data.voiceId.slice(0, 8) }))
  return json({ ok: true, providerExpiresAt: Number.isFinite(exp) && exp > 0 ? exp * 1000 : null })
}

export const POST = withJsonErrors('voices/renew', handlePOST)
