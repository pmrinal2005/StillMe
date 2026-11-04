import { describe, expect, it } from 'vitest'
import { CONSENT_PERIOD_DAYS, DEFAULT_VOICE_ID, LIBRARY_VOICES, clonedVoiceUsable, consentExpiry, isLibraryVoice, libraryVoicesFor, type ClonedVoiceProfile } from '@/lib/voices'
import { OUTPUT_LANGUAGES } from '@/lib/contracts'
import { hasNoSpokenOutput as unsupportedOutputFor } from '@/lib/languages'

const DAY = 86_400_000
const now = Date.parse('2026-11-01T00:00:00Z')
const voice = (over: Partial<ClonedVoiceProfile> = {}): ClonedVoiceProfile => ({
  id: 'r1', voiceId: 'clone-1', label: 'Me', ownerName: 'Owner', region: 'us', recordingLanguage: 'english',
  provenance: 'self-recorded', provenanceNote: '', speakerConsent: true, rightsConfirmed: true, biometricTermsAccepted: true,
  consentAt: now - DAY, revoked: false, fallbackVoiceId: DEFAULT_VOICE_ID, qualityChecked: true, ...over,
})

describe('voice wardrobe', () => {
  it('library voices only use supported TTS languages (no Hindi)', () => {
    for (const v of LIBRARY_VOICES) expect(OUTPUT_LANGUAGES).toContain(v.language)
    expect(OUTPUT_LANGUAGES as readonly string[]).not.toContain('hindi')
    expect(isLibraryVoice(DEFAULT_VOICE_ID)).toBe(true)
    expect(isLibraryVoice('clone-1')).toBe(false) // a voice id is not a permission token
  })
  it('usable clone with complete consent', () => {
    expect(clonedVoiceUsable(voice(), 'us', now)).toMatchObject({ ok: true, remindRenewal: false })
  })
  it('expires 60 days after last consent; reminds within 10 days', () => {
    expect(consentExpiry(voice())).toBe(now - DAY + CONSENT_PERIOD_DAYS * DAY)
    expect(clonedVoiceUsable(voice({ consentAt: now - 55 * DAY }), 'us', now)).toMatchObject({ ok: true, remindRenewal: true })
    expect(clonedVoiceUsable(voice({ consentAt: now - 60 * DAY }), 'us', now)).toEqual({ ok: false, reason: 'expired' })
  })
  it('provider-reported expiry takes precedence', () => {
    expect(clonedVoiceUsable(voice({ providerExpiresAt: now - 1 }), 'us', now)).toEqual({ ok: false, reason: 'expired' })
  })
  it('revoked, incomplete consent and region mismatch are refused', () => {
    expect(clonedVoiceUsable(voice({ revoked: true }), 'us', now)).toEqual({ ok: false, reason: 'revoked' })
    expect(clonedVoiceUsable(voice({ speakerConsent: false }), 'us', now)).toEqual({ ok: false, reason: 'incomplete_consent' })
    expect(clonedVoiceUsable(voice({ biometricTermsAccepted: false }), 'us', now)).toEqual({ ok: false, reason: 'incomplete_consent' })
    expect(clonedVoiceUsable(voice({ rightsConfirmed: false }), 'us', now)).toEqual({ ok: false, reason: 'incomplete_consent' })
    expect(clonedVoiceUsable(voice({ region: 'eu' }), 'us', now)).toEqual({ ok: false, reason: 'region_mismatch' })
  })
  it('input language is independent of output language (Hindi input has no spoken-output match)', () => {
    expect(unsupportedOutputFor('hi')).toBe(true)
    expect(unsupportedOutputFor('en')).toBe(false)
  })
  it('every library voice id is unique and slug-shaped (a radio selection maps to exactly one voice)', () => {
    const ids = LIBRARY_VOICES.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^aai-[a-z]+$/)
  })
  it('every supported spoken-output language offers at least one library voice of its own', () => {
    for (const lang of OUTPUT_LANGUAGES) {
      const own = LIBRARY_VOICES.filter((v) => v.language === lang)
      expect(own.length, `no voice for ${lang}`).toBeGreaterThan(0)
      expect(libraryVoicesFor(lang)).toEqual(own)
    }
  })
  it('Italian output is selectable (built-in voices speak it; verified live)', () => {
    expect(libraryVoicesFor('italian').map((v) => v.id)).toEqual(expect.arrayContaining(['aai-alba', 'aai-eve']))
  })
})
