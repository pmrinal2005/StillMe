import { z } from 'zod'
import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { ttsBase } from '@/lib/server/assemblyai'
import { ledgerFor } from '@/lib/server/state'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

const Body = z.object({
  voiceId: z.string().min(1).max(128),
  /** The owner must type this exact phrase — consent is never silently extended. */
  affirmation: z.literal('I consent to renew use of my synthetic voice'),
  speakerIsOwner: z.literal(true),
})

/**
 * Affirmative consent renewal through the documented route: a speech request by the owning
 * account with extend_biometric_consent=true. Uses a minimal 2-character text (billed) and
 * buffers the response so the renewed expiry is reported in X-TTS-Voice-Expires-At.
 */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  const key = env.assemblyKey()
  if (!key) return json({ error: 'assemblyai_not_configured' }, 503)
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'affirmation_required' }, 400)
  const r = ledgerFor(id.userId).reserveTts(2)
  if (!r.ok) return json({ error: 'budget', reason: r.reason }, 429)
  const res = await fetch(`${ttsBase()}/v1/speech`, {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Ok', voice_id: parsed.data.voiceId, stream: false, extend_biometric_consent: true, encoding: 'mp3' }),
  })
  if (!res.ok) {
    ledgerFor(id.userId).releaseTts(r.id)
    const j = await res.json().catch(() => ({}))
    return json({ error: j.code ?? 'renew_failed', message: j.message }, res.status === 422 ? 422 : 502)
  }
  await res.arrayBuffer()
  ledgerFor(id.userId).commitTts(r.id, Number(res.headers.get('x-tts-billed-characters')) || 2)
  const exp = Number(res.headers.get('x-tts-voice-expires-at'))
  console.log(JSON.stringify({ evt: 'consent_renewed', voice: parsed.data.voiceId.slice(0, 8) }))
  return json({ ok: true, providerExpiresAt: Number.isFinite(exp) && exp > 0 ? exp * 1000 : null })
}

export const POST = withJsonErrors('voices/renew', handlePOST)
