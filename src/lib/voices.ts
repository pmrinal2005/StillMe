/**
 * Voice wardrobe = authorized voice choices. A voice ID is NOT a permission token.
 *
 * Library voices are AssemblyAI catalog voices. Cloned voices are created ONLY through the
 * AssemblyAI dashboard workflow (record/upload → provenance → speaker consent → biometric terms),
 * then registered here with consent metadata. There is no API clone-creation endpoint.
 */
import { OUTPUT_LANGUAGES, type OutputLanguage } from './contracts'

export interface LibraryVoice {
  id: string
  name: string
  language: OutputLanguage
  description: string
}

/**
 * Library voices. Every id below was synthesized against the live AssemblyAI TTS API
 * (assemblyai-tts-1, us zone) with its listed language — see scripts/live-smoke.mjs.
 *
 * Italian has no native catalog voice in the public list, so Italian uses AssemblyAI's built-in voices
 * (they speak any of the six languages; AssemblyAI notes quality is usually better in the voice's own
 * language). Each voice id appears ONCE so a radio selection maps to exactly one entry.
 */
export const LIBRARY_VOICES: LibraryVoice[] = [
  { id: 'aai-audrey', name: 'Audrey', language: 'english', description: 'Middle-aged woman, even, steady, American English' },
  { id: 'aai-jane', name: 'Jane (default)', language: 'english', description: 'Built-in default voice, English' },
  { id: 'aai-peter', name: 'Peter', language: 'english', description: 'Middle-aged man, soft-spoken, American English' },
  { id: 'aai-sara', name: 'Sara', language: 'english', description: 'Young woman, even intonation, American English' },
  { id: 'aai-titus', name: 'Titus', language: 'english', description: 'Young man, deep voice, American English' },
  { id: 'aai-aaliyah', name: 'Aaliyah', language: 'english', description: 'Young woman, fairly high-pitched, American English' },
  { id: 'aai-kyla', name: 'Kyla', language: 'english', description: 'Young woman, fast pace, American English' },
  { id: 'aai-nancy', name: 'Nancy', language: 'english', description: 'Middle-aged woman, even tone, British English' },
  { id: 'aai-carrie', name: 'Carrie', language: 'english', description: 'Middle-aged woman, soft-spoken, British English' },
  { id: 'aai-buford', name: 'Buford', language: 'english', description: 'Older man, energetic, British English' },
  { id: 'aai-troy', name: 'Troy', language: 'english', description: 'Young man, soft-spoken, deep, Scottish English' },
  { id: 'aai-gunnar', name: 'Gunnar', language: 'english', description: 'Older man, fairly slow pace, English' },
  { id: 'aai-steven', name: 'Steven', language: 'english', description: 'Middle-aged man, Australian English' },
  { id: 'aai-constanza', name: 'Constanza', language: 'spanish', description: 'Young woman, Mexican Spanish' },
  { id: 'aai-malvina', name: 'Malvina', language: 'spanish', description: 'Middle-aged woman, soft-spoken, Mexican Spanish' },
  { id: 'aai-oriol', name: 'Oriol', language: 'spanish', description: 'Middle-aged man, Mexican Spanish' },
  { id: 'aai-antonioluis', name: 'Antonio Luis', language: 'spanish', description: 'Middle-aged man, deep voice, Mexican Spanish' },
  { id: 'aai-jorg', name: 'Jörg', language: 'german', description: 'Middle-aged man, German' },
  { id: 'aai-gunther', name: 'Günther', language: 'german', description: 'Middle-aged man, soft-spoken, German' },
  { id: 'aai-magdalena', name: 'Magdalena', language: 'german', description: 'Young woman, German' },
  { id: 'aai-alba', name: 'Alba', language: 'italian', description: 'Built-in voice speaking Italian (no native Italian catalog voice is listed)' },
  { id: 'aai-eve', name: 'Eve', language: 'italian', description: 'Built-in voice speaking Italian (no native Italian catalog voice is listed)' },
  { id: 'aai-donatien', name: 'Donatien', language: 'french', description: 'Middle-aged man, French' },
  { id: 'aai-benicio', name: 'Benício', language: 'portuguese', description: 'Young man, Portuguese' },
]

/** Library voices to offer for a spoken-output language (never empty: every supported language has at least one). */
export function libraryVoicesFor(language: OutputLanguage): LibraryVoice[] {
  const own = LIBRARY_VOICES.filter((v) => v.language === language)
  return own.length ? own : LIBRARY_VOICES
}

export const DEFAULT_VOICE_ID = 'aai-audrey'
export const CONSENT_PERIOD_DAYS = 60
export const CONSENT_REMIND_DAYS = 10

export interface ClonedVoiceProfile {
  /** Local record id */
  id: string
  /** AssemblyAI voice id (UUID or account slug) */
  voiceId: string
  label: string
  ownerName: string
  region: 'us' | 'eu'
  recordingLanguage: OutputLanguage
  provenance: 'self-recorded' | 'voicemail' | 'other-recording'
  provenanceNote: string
  speakerConsent: boolean
  rightsConfirmed: boolean
  biometricTermsAccepted: boolean
  consentAt: number // ms epoch, last affirmative consent
  /** Provider-reported expiry (X-TTS-Voice-Expires-At), if observed */
  providerExpiresAt?: number
  revoked: boolean
  fallbackVoiceId: string
  qualityChecked: boolean
}

export function isOutputLanguage(x: string): x is OutputLanguage {
  return (OUTPUT_LANGUAGES as readonly string[]).includes(x)
}

export function consentExpiry(v: Pick<ClonedVoiceProfile, 'consentAt' | 'providerExpiresAt'>): number {
  return v.providerExpiresAt ?? v.consentAt + CONSENT_PERIOD_DAYS * 86_400_000
}

export type VoiceUsability =
  | { ok: true; remindRenewal: boolean; expiresAt: number }
  | { ok: false; reason: 'revoked' | 'expired' | 'incomplete_consent' | 'region_mismatch' }

/** A cloned voice may only be used when every consent field is affirmative, not revoked, not expired, same region. */
export function clonedVoiceUsable(v: ClonedVoiceProfile, region: 'us' | 'eu', now = Date.now()): VoiceUsability {
  if (v.revoked) return { ok: false, reason: 'revoked' }
  if (!v.speakerConsent || !v.rightsConfirmed || !v.biometricTermsAccepted) return { ok: false, reason: 'incomplete_consent' }
  if (v.region !== region) return { ok: false, reason: 'region_mismatch' }
  const expiresAt = consentExpiry(v)
  if (now >= expiresAt) return { ok: false, reason: 'expired' }
  return { ok: true, remindRenewal: expiresAt - now < CONSENT_REMIND_DAYS * 86_400_000, expiresAt }
}

export function isLibraryVoice(id: string) {
  return LIBRARY_VOICES.some((v) => v.id === id)
}
