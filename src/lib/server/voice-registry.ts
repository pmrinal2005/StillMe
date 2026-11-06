import 'server-only'
import { adminClient } from './durable'
import { env } from './env'
import { randomId } from '../hash'
import { adoptProviderExpiry, clonedVoiceUsable, isLibraryVoice, type ClonedVoiceProfile } from '../voices'

/**
 * B11/B12 — SERVER-SIDE cloned-voice registry.
 *
 * Bug: the consent record for a cloned voice lived only in the browser (IndexedDB) and was sent to /api/approve as a
 * self-made "attestation". Anyone could claim ANY voice id of the shared AssemblyAI account with consent flags they
 * typed themselves, and /api/speak + the session start never looked at the voice at all. A voice id is not a
 * permission token: the server now records consent, binds the voice id to ONE account, and every path that can
 * produce speech (session start, approve, speak, renew) re-checks owner + consent + expiry + revocation + region.
 *
 * Store: Supabase `voice_profiles` (+ append-only `biometric_consents`) via the service role (clients can only READ
 * their own rows — migration 0004). Without a durable store (local prototype) an in-process registry is used.
 */

export class VoiceRegistryError extends Error {
  constructor(public code: string, public status: number, message?: string) {
    super(message ?? code)
  }
}

export type ConsentAction = 'initial' | 'renewal' | 'revocation'

export interface VoiceStore {
  list(userId: string): Promise<ClonedVoiceProfile[]>
  get(userId: string, voiceId: string): Promise<ClonedVoiceProfile | null>
  /** Who holds the claim on this provider voice id (any account, revoked or not), or a tombstone. */
  claim(voiceId: string): Promise<{ userId: string } | 'tombstoned' | null>
  insert(userId: string, p: ClonedVoiceProfile): Promise<void>
  update(userId: string, id: string, patch: Partial<ClonedVoiceProfile>): Promise<void>
  consent(userId: string, p: ClonedVoiceProfile, action: ConsentAction, at: number): Promise<void>
  /** Account deletion: revoke every voice of the user and tombstone its provider id. Returns the ids. */
  tombstoneAll(userId: string): Promise<string[]>
}

// ------------------------------------------------------------------------------------------------- memory store
interface MemState {
  voices: Map<string, ClonedVoiceProfile & { userId: string }>
  tombs: Set<string>
}
const g = globalThis as unknown as { __rvVoices?: MemState }
const mem = (): MemState => (g.__rvVoices ??= { voices: new Map(), tombs: new Set() })

export function memoryVoiceStore(): VoiceStore {
  const k = (userId: string, voiceId: string) => `${userId}|${voiceId}`
  const strip = ({ userId: _u, ...p }: ClonedVoiceProfile & { userId: string }): ClonedVoiceProfile => p
  return {
    async list(userId) {
      return [...mem().voices.values()].filter((v) => v.userId === userId).map(strip)
    },
    async get(userId, voiceId) {
      const v = mem().voices.get(k(userId, voiceId))
      return v ? strip(v) : null
    },
    async claim(voiceId) {
      if (mem().tombs.has(voiceId)) return 'tombstoned'
      for (const v of mem().voices.values()) if (v.voiceId === voiceId) return { userId: v.userId }
      return null
    },
    async insert(userId, p) {
      mem().voices.set(k(userId, p.voiceId), { ...p, userId })
    },
    async update(userId, id, patch) {
      for (const [key, v] of mem().voices) if (v.userId === userId && v.id === id) mem().voices.set(key, { ...v, ...patch })
    },
    async consent() {},
    async tombstoneAll(userId) {
      const ids: string[] = []
      for (const [key, v] of mem().voices) {
        if (v.userId !== userId) continue
        mem().tombs.add(v.voiceId)
        ids.push(v.voiceId)
        mem().voices.delete(key)
      }
      return ids
    },
  }
}

/** Test helper. */
export function resetMemoryVoices() {
  g.__rvVoices = undefined
}

// ------------------------------------------------------------------------------------------------ supabase store
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
const COLS =
  'id, provider_voice_id, label, owner_name, region, recording_language, provenance, provenance_note, fallback_voice_id, revoked, speaker_consent, rights_confirmed, biometric_terms_accepted, quality_checked, consent_at, provider_expires_at'

interface Row {
  id: string
  provider_voice_id: string
  label: string
  owner_name: string | null
  region: 'us' | 'eu'
  recording_language: ClonedVoiceProfile['recordingLanguage'] | null
  provenance: ClonedVoiceProfile['provenance'] | null
  provenance_note: string | null
  fallback_voice_id: string
  revoked: boolean
  speaker_consent: boolean
  rights_confirmed: boolean
  biometric_terms_accepted: boolean
  quality_checked: boolean
  consent_at: string | null
  provider_expires_at: string | null
}

const fromRow = (r: Row): ClonedVoiceProfile => ({
  id: r.id,
  voiceId: r.provider_voice_id,
  label: r.label,
  ownerName: r.owner_name ?? '',
  region: r.region,
  recordingLanguage: r.recording_language ?? 'english',
  provenance: r.provenance ?? 'other-recording',
  provenanceNote: r.provenance_note ?? '',
  speakerConsent: r.speaker_consent,
  rightsConfirmed: r.rights_confirmed,
  biometricTermsAccepted: r.biometric_terms_accepted,
  consentAt: r.consent_at ? Date.parse(r.consent_at) : 0, // never consented → expired (fails closed)
  providerExpiresAt: r.provider_expires_at ? Date.parse(r.provider_expires_at) : undefined,
  revoked: r.revoked,
  fallbackVoiceId: r.fallback_voice_id,
  qualityChecked: r.quality_checked,
})

const iso = (ms: number) => new Date(ms).toISOString()

/** Schema problems (migration 0004 not applied) must fail CLOSED and say so — never silently allow a clone. */
function dbFail(err: { code?: string; message?: string } | null): never {
  if (err && err.code === '23503') {
    throw new VoiceRegistryError('voice_registry_migration_required', 503, 'Apply supabase/migrations/0007_no_signin.sql to enable cloned voices (device ids are not auth users).')
  }
  if (err && (err.code === '42703' || err.code === 'PGRST204' || err.code === '42P01' || err.code === 'PGRST205' || /column .* does not exist|schema cache/i.test(err.message ?? ''))) {
    throw new VoiceRegistryError('voice_registry_migration_required', 503, 'Apply supabase/migrations/0004_security_consent.sql to enable cloned voices.')
  }
  throw new VoiceRegistryError('voice_registry_unavailable', 503)
}

export function supabaseVoiceStore(): VoiceStore | null {
  const sb = adminClient()
  if (!sb) return null
  return {
    async list(userId) {
      const { data, error } = await sb.from('voice_profiles').select(COLS).eq('user_id', userId).eq('kind', 'cloned').order('created_at')
      if (error) dbFail(error)
      return (data as Row[]).map(fromRow)
    },
    async get(userId, voiceId) {
      const { data, error } = await sb.from('voice_profiles').select(COLS).eq('user_id', userId).eq('kind', 'cloned').eq('provider_voice_id', voiceId).limit(1)
      if (error) dbFail(error)
      return data?.length ? fromRow(data[0] as Row) : null
    },
    async claim(voiceId) {
      const t = await sb.from('voice_tombstones').select('provider_voice_id').eq('provider_voice_id', voiceId).limit(1)
      if (t.error) dbFail(t.error)
      if (t.data?.length) return 'tombstoned'
      const { data, error } = await sb.from('voice_profiles').select('user_id').eq('provider_voice_id', voiceId).limit(1)
      if (error) dbFail(error)
      return data?.length ? { userId: (data[0] as { user_id: string }).user_id } : null
    },
    async insert(userId, p) {
      const { error } = await sb.from('voice_profiles').insert({
        id: p.id, user_id: userId, kind: 'cloned', provider_voice_id: p.voiceId, label: p.label, owner_name: p.ownerName, region: p.region,
        recording_language: p.recordingLanguage, provenance: p.provenance, provenance_note: p.provenanceNote || null, fallback_voice_id: p.fallbackVoiceId,
        revoked: false, speaker_consent: p.speakerConsent, rights_confirmed: p.rightsConfirmed, biometric_terms_accepted: p.biometricTermsAccepted,
        quality_checked: p.qualityChecked, consent_at: iso(p.consentAt), provider_expires_at: p.providerExpiresAt ? iso(p.providerExpiresAt) : null,
      })
      if (error) {
        if (error.code === '23505') throw new VoiceRegistryError('voice_claimed', 409, 'This voice id is already registered to an account.')
        dbFail(error)
      }
    },
    async update(userId, id, patch) {
      const row: Record<string, unknown> = {}
      if (patch.label !== undefined) row.label = patch.label
      if (patch.ownerName !== undefined) row.owner_name = patch.ownerName
      if (patch.recordingLanguage !== undefined) row.recording_language = patch.recordingLanguage
      if (patch.provenance !== undefined) row.provenance = patch.provenance
      if (patch.provenanceNote !== undefined) row.provenance_note = patch.provenanceNote || null
      if (patch.fallbackVoiceId !== undefined) row.fallback_voice_id = patch.fallbackVoiceId
      if (patch.speakerConsent !== undefined) row.speaker_consent = patch.speakerConsent
      if (patch.rightsConfirmed !== undefined) row.rights_confirmed = patch.rightsConfirmed
      if (patch.biometricTermsAccepted !== undefined) row.biometric_terms_accepted = patch.biometricTermsAccepted
      if (patch.qualityChecked !== undefined) row.quality_checked = patch.qualityChecked
      if (patch.consentAt !== undefined) row.consent_at = iso(patch.consentAt)
      if (patch.providerExpiresAt !== undefined) row.provider_expires_at = patch.providerExpiresAt ? iso(patch.providerExpiresAt) : null
      if (patch.revoked !== undefined) {
        row.revoked = patch.revoked
        row.revoked_at = patch.revoked ? iso(Date.now()) : null
      }
      const { error } = await sb.from('voice_profiles').update(row).eq('id', id).eq('user_id', userId)
      if (error) dbFail(error)
    },
    async consent(userId, p, action, at) {
      const { error } = await sb.from('biometric_consents').insert({
        user_id: userId, voice_profile_id: p.id, speaker_consent: action === 'revocation' ? false : true,
        rights_confirmed: action === 'revocation' ? false : true, biometric_terms_accepted: action === 'revocation' ? false : true,
        consented_at: iso(at), expected_expiry: iso(p.providerExpiresAt ?? at + 60 * 86_400_000),
        provider_expires_at: p.providerExpiresAt ? iso(p.providerExpiresAt) : null, action,
      })
      if (error) dbFail(error)
    },
    async tombstoneAll(userId) {
      const { data, error } = await sb.from('voice_profiles').select('id, provider_voice_id, region').eq('user_id', userId).eq('kind', 'cloned')
      if (error) dbFail(error)
      const rows = (data ?? []) as { id: string; provider_voice_id: string; region: 'us' | 'eu' }[]
      if (!rows.length) return []
      const ins = await sb.from('voice_tombstones').upsert(rows.map((r) => ({ provider_voice_id: r.provider_voice_id, region: r.region, reason: 'account_deleted' })), { onConflict: 'provider_voice_id' })
      if (ins.error) dbFail(ins.error)
      const rev = await sb.from('voice_profiles').update({ revoked: true, revoked_at: iso(Date.now()) }).eq('user_id', userId)
      if (rev.error) dbFail(rev.error)
      return rows.map((r) => r.provider_voice_id)
    },
  }
}

/** Durable registry for real (uuid) accounts when Supabase is configured; the in-process registry otherwise. */
export function voiceStoreFor(userId: string): VoiceStore {
  return (isUuid(userId) ? supabaseVoiceStore() : null) ?? memoryVoiceStore()
}

// ------------------------------------------------------------------------------------------------ registry logic
export interface RegisterInput {
  voiceId: string
  label: string
  ownerName: string
  recordingLanguage: ClonedVoiceProfile['recordingLanguage']
  provenance: ClonedVoiceProfile['provenance']
  provenanceNote: string
  fallbackVoiceId: string
  qualityChecked: boolean
}

/**
 * Bind a provider voice id to ONE account with complete, affirmative consent recorded server-side.
 * The caller has already confirmed with the provider that the voice exists in this account/region.
 */
export async function registerClonedVoice(store: VoiceStore, userId: string, input: RegisterInput, ctx: { region: 'us' | 'eu'; providerExpiresAt?: number; now?: number }): Promise<ClonedVoiceProfile> {
  const now = ctx.now ?? Date.now()
  if (isLibraryVoice(input.voiceId)) throw new VoiceRegistryError('library_voice', 400, 'Library voices need no registration.')
  if (!isLibraryVoice(input.fallbackVoiceId)) throw new VoiceRegistryError('invalid_fallback', 400, 'The fallback must be a library voice.')
  const claim = await store.claim(input.voiceId)
  if (claim === 'tombstoned') throw new VoiceRegistryError('voice_tombstoned', 409, 'This voice belonged to a deleted account and cannot be registered.')
  if (claim && claim.userId !== userId) throw new VoiceRegistryError('voice_claimed', 409, 'This voice id is already registered to another account.')
  const existing = claim ? await store.get(userId, input.voiceId) : null
  const profile: ClonedVoiceProfile = {
    id: existing?.id ?? randomId(16).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5'),
    voiceId: input.voiceId,
    label: input.label,
    ownerName: input.ownerName,
    region: ctx.region,
    recordingLanguage: input.recordingLanguage,
    provenance: input.provenance,
    provenanceNote: input.provenanceNote,
    speakerConsent: true,
    rightsConfirmed: true,
    biometricTermsAccepted: true,
    consentAt: now,
    providerExpiresAt: ctx.providerExpiresAt,
    revoked: false,
    fallbackVoiceId: input.fallbackVoiceId,
    qualityChecked: input.qualityChecked,
  }
  if (existing) {
    // Same owner registering again (e.g. after a revocation): fresh affirmative consent, never a silent re-enable.
    await store.update(userId, existing.id, { ...profile, revoked: false })
  } else {
    await store.insert(userId, profile)
  }
  await store.consent(userId, profile, 'initial', now)
  return profile
}

export async function revokeClonedVoice(store: VoiceStore, userId: string, voiceId: string, now = Date.now()): Promise<ClonedVoiceProfile> {
  const p = await store.get(userId, voiceId)
  if (!p) throw new VoiceRegistryError('voice_not_registered', 404)
  if (!p.revoked) {
    await store.update(userId, p.id, { revoked: true })
    await store.consent(userId, { ...p, revoked: true }, 'revocation', now)
  }
  return { ...p, revoked: true }
}

export async function recordRenewal(store: VoiceStore, userId: string, voiceId: string, providerExpiresAt: number | undefined, now = Date.now()): Promise<ClonedVoiceProfile> {
  const p = await store.get(userId, voiceId)
  if (!p) throw new VoiceRegistryError('voice_not_registered', 403)
  if (p.revoked) throw new VoiceRegistryError('voice_revoked', 409)
  const next: ClonedVoiceProfile = { ...p, consentAt: now, providerExpiresAt, speakerConsent: true }
  await store.update(userId, p.id, { consentAt: now, providerExpiresAt: providerExpiresAt ?? undefined, speakerConsent: true })
  await store.consent(userId, next, 'renewal', now)
  return next
}

/**
 * D #38: store the provider-reported expiry that /api/speak observed. Without this the consent expiry stayed an estimate
 * (consentAt + 60 days) even though every cloned-voice utterance reports the real date. Only a plausible FUTURE value
 * that differs from the stored one by more than a minute is written (no write per utterance).
 */
export async function persistProviderExpiry(store: VoiceStore, userId: string, profile: ClonedVoiceProfile, expiresAtMs: number | undefined, now = Date.now()): Promise<boolean> {
  const next = adoptProviderExpiry(profile.providerExpiresAt, expiresAtMs, now)
  if (next === undefined) return false
  await store.update(userId, profile.id, { providerExpiresAt: next })
  return true
}

export type VoiceAuth =
  | { ok: true; kind: 'library' }
  | { ok: true; kind: 'cloned'; profile: ClonedVoiceProfile; remindRenewal: boolean; expiresAt: number }
  | { ok: false; reason: 'not_registered' | 'revoked' | 'expired' | 'incomplete_consent' | 'region_mismatch' }

/**
 * THE authorization decision for a voice id. Library voices are open to everyone; a cloned voice is usable only by
 * the DEVICE identity that registered it, with complete unrevoked unexpired consent in the server's data zone.
 */
export async function authorizeVoice(store: VoiceStore, id: { userId: string }, voiceId: string, region: 'us' | 'eu', now = Date.now()): Promise<VoiceAuth> {
  if (isLibraryVoice(voiceId)) return { ok: true, kind: 'library' }
  const p = await store.get(id.userId, voiceId)
  if (!p) return { ok: false, reason: 'not_registered' }
  const u = clonedVoiceUsable(p, region, now)
  if (!u.ok) return { ok: false, reason: u.reason }
  return { ok: true, kind: 'cloned', profile: p, remindRenewal: u.remindRenewal, expiresAt: u.expiresAt }
}
