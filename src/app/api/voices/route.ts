import { z } from 'zod'
import { getIdentity, json, requireAccount, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { parseVoiceExpiryMs, ttsBase } from '@/lib/server/assemblyai'
import { reserveTtsSpend } from '@/lib/server/spend'
import { allow } from '@/lib/server/rate-limit'
import { audit } from '@/lib/server/durable'
import { mayRegisterClone, registerClonedVoice, VoiceRegistryError, voiceStoreFor } from '@/lib/server/voice-registry'
import { OutputLanguage, TTS_MODEL } from '@/lib/contracts'
import { codePoints } from '@/lib/hash'
import { fallbackVoiceFor, isLibraryVoice } from '@/lib/voices'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

const Body = z.object({
  voiceId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
  label: z.string().trim().min(1).max(80),
  ownerName: z.string().trim().min(1).max(80),
  recordingLanguage: OutputLanguage,
  provenance: z.enum(['self-recorded', 'voicemail', 'other-recording']),
  provenanceNote: z.string().max(300).default(''),
  /** D #39: optional — defaults to a library voice that speaks the recording language (not always English). */
  fallbackVoiceId: z.string().min(1).max(128).optional(),
  qualityChecked: z.literal(true),
  // Affirmative consent: all three must be literally true, recorded by the SERVER with a server timestamp.
  speakerConsent: z.literal(true),
  rightsConfirmed: z.literal(true),
  biometricTermsAccepted: z.literal(true),
})

/** B11: the caller's own server-side registry (the browser copy is only a cache of this). */
async function handleGET(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  { const gate = requireAccount(id, 'cloned voices'); if (gate) return gate }
  const voices = await voiceStoreFor(id.userId).list(id.userId)
  return json({ voices, region: env.assemblyRegion() })
}

/**
 * B11: register a cloned voice. The server (a) requires a real account, (b) records the consent itself, (c) binds the
 * provider voice id to this ONE account (first verified claim; a deleted account's id is tombstoned), and (d) asks
 * AssemblyAI to speak two characters with it, which proves the voice exists in THIS data zone and reports the
 * provider's consent expiry. A voice id alone never grants use.
 */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  { const gate = requireAccount(id, 'cloned voices'); if (gate) return gate }
  if (!mayRegisterClone(id)) return json({ error: 'registration_not_allowed', message: 'This deployment restricts who may register cloned voices.' }, 403)
  const key = env.assemblyKey()
  if (!key) return json({ error: 'assemblyai_not_configured' }, 503)
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'consent_required', message: 'Every consent confirmation and the voice details are required.', issues: parsed.error.issues.slice(0, 4).map((i) => i.path.join('.')) }, 400)
  const b = parsed.data
  if (isLibraryVoice(b.voiceId)) return json({ error: 'library_voice', message: 'Library voices need no registration.' }, 400)
  if (!allow(`voice-register:${id.userId}`, 5, 60 * 60_000)) return json({ error: 'rate_limited', message: 'Too many registration attempts. Try again later.' }, 429)

  const store = voiceStoreFor(id.userId)
  // Cheap ownership pre-check BEFORE spending a (billed) provider call on someone else's / a tombstoned id.
  const claim = await store.claim(b.voiceId)
  if (claim === 'tombstoned') return json({ error: 'voice_tombstoned', message: 'This voice belonged to a deleted account and cannot be registered.' }, 409)
  if (claim && claim.userId !== id.userId) return json({ error: 'voice_claimed', message: 'This voice id is already registered to another account.' }, 409)

  const text = 'Ok'
  const spend = await reserveTtsSpend(id, req, codePoints(text))
  if (!spend.ok) return json(spend.body, spend.status)
  let res: Response
  try {
    res = await fetch(`${ttsBase()}/v1/speech`, {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/json' },
      // NEVER extend_biometric_consent here: registration is not renewal.
      body: JSON.stringify({ text, voice_id: b.voiceId, model_id: TTS_MODEL, language: b.recordingLanguage, stream: false, encoding: 'mp3' }),
    })
  } catch (e) {
    await spend.release()
    throw e
  }
  if (!res.ok) {
    await spend.release()
    const j = await res.json().catch(() => ({}))
    const missing = res.status === 404 || res.status === 422 || res.status === 400 || res.status === 403
    return json({ error: missing ? 'voice_not_found' : 'provider_error', message: missing ? 'AssemblyAI does not know this voice id in this data zone. Create it in the dashboard first.' : undefined, code: j.code }, missing ? 422 : 502)
  }
  await res.arrayBuffer()
  await spend.commit(Number(res.headers.get('x-tts-billed-characters')) || codePoints(text))
  try {
    // D #39: the default fallback speaks the recording language (an English-only default read Spanish text in Audrey).
    const fallbackVoiceId = b.fallbackVoiceId ?? fallbackVoiceFor(b.recordingLanguage)
    const profile = await registerClonedVoice(store, id.userId, { ...b, fallbackVoiceId }, { region: env.assemblyRegion(), providerExpiresAt: parseVoiceExpiryMs(res.headers.get('x-tts-voice-expires-at')) })
    void audit(id.userId, 'voice_registered', profile.id)
    return json({ ok: true, voice: profile })
  } catch (e) {
    if (e instanceof VoiceRegistryError) return json({ error: e.code, message: e.message }, e.status)
    throw e
  }
}

export const GET = withJsonErrors('voices', handleGET)
export const POST = withJsonErrors('voices', handlePOST)
