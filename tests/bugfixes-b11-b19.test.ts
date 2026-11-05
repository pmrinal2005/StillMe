/**
 * Regression tests for the B-series (critical security, consent and authorization):
 *  B11/B12 server-side cloned-voice registry (owner + consent + expiry + revocation + region, one claim per voice id)
 *  B13     operator allowlist fails closed; reconcile seed is clamped
 *  B14     Supabase anonymous users are guests
 *  B15     phone bind brute-force guard (failures counted per call / identity / global, live codes burned)
 *  B16     sealed room metadata
 *  B17     single-use partner invites without an owner id
 *  B18     minimal public status
 *  B19     real account deletion (tombstones, step report) + export
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomMetadata } from '@/lib/server/livekit'
import { SECRET } from './helpers'

const rooms = new Map<string, RoomMetadata>()
vi.mock('@/lib/server/livekit', async (orig) => {
  const real = await orig<typeof import('@/lib/server/livekit')>()
  return {
    ...real,
    getRoomMeta: async (room: string) => (rooms.has(room) ? structuredClone(rooms.get(room)!) : null),
    listAllOwnerRooms: async () => [...rooms].map(([room, meta]) => ({ room, meta: structuredClone(meta) })),
    listOwnerRooms: async (userId: string) => [...rooms].filter(([, m]) => m.ownerIdentity === userId).map(([room, meta]) => ({ room, meta: structuredClone(meta) })),
    updateRoomMeta: async (room: string, meta: RoomMetadata) => {
      if (!rooms.has(room)) throw new Error('room not found')
      rooms.set(room, structuredClone(meta))
    },
    deleteRoom: async (room: string) => {
      rooms.delete(room)
    },
  }
})

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }) }))

const ROOM = 'rv-0123456789abcdef01234567'
const baseMeta = (owner = 'owner-uuid'): RoomMetadata => ({ ownerIdentity: owner, conversationId: 'c1', generation: 0, mode: 'partner-link', maxSessionMinutes: 20 })

beforeEach(async () => {
  rooms.clear()
  vi.stubEnv('REVOICE_APPROVAL_SECRET', SECRET)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
  const { resetMemoryVoices } = await import('@/lib/server/voice-registry')
  resetMemoryVoices()
  const { resetInviteMemory } = await import('@/lib/server/invites')
  resetInviteMemory()
  const { reset } = await import('@/lib/server/rate-limit')
  reset()
})
afterEach(() => vi.unstubAllEnvs())

// ------------------------------------------------------------------------------------------------- B13 / B14
describe('B13 — operator allowlist fails closed', () => {
  const real = (over = {}) => ({ userId: '11111111-1111-4111-8111-111111111111', kind: 'supabase' as const, email: 'boss@example.com', emailVerified: true, ...over })

  it('with BOTH lists empty nobody is an operator (was: everybody)', async () => {
    vi.stubEnv('REVOICE_OPERATOR_IDS', '')
    vi.stubEnv('REVOICE_OPERATOR_EMAILS', '')
    const { isOperator } = await import('@/lib/server/auth')
    expect(isOperator(real())).toBe(false)
    expect(isOperator({ userId: 'guest-x', kind: 'guest' })).toBe(false)
    expect(isOperator({ userId: 'demo-x', kind: 'local-demo' })).toBe(false)
  })

  it('id allowlist works; e-mail allowlist needs a CONFIRMED address', async () => {
    const { isOperator } = await import('@/lib/server/auth')
    vi.stubEnv('REVOICE_OPERATOR_IDS', '11111111-1111-4111-8111-111111111111')
    expect(isOperator(real({ email: undefined }))).toBe(true)
    vi.stubEnv('REVOICE_OPERATOR_IDS', '')
    vi.stubEnv('REVOICE_OPERATOR_EMAILS', 'Boss@Example.com')
    expect(isOperator(real())).toBe(true)
    expect(isOperator(real({ emailVerified: false }))).toBe(false)
    expect(isOperator(real({ email: 'other@example.com' }))).toBe(false)
    expect(isOperator(real({ anonymous: true }))).toBe(false)
  })

  it('the reconcile seed is clamped so one typo cannot lock every user out', async () => {
    const { clampReconcileSeed } = await import('@/lib/reconcile')
    const { LIMITS } = await import('@/lib/budget')
    expect(clampReconcileSeed(100_000)).toBe(LIMITS.assembly.totalCreditUsd)
    expect(clampReconcileSeed(-5)).toBe(0)
    expect(clampReconcileSeed(Number.NaN)).toBe(0)
    expect(clampReconcileSeed(1.5)).toBe(1.5)
  })
})

describe('B14 — anonymous Supabase users are guests', () => {
  it('recognises every shape Supabase uses for anonymous users', async () => {
    const { isAnonymousSupabaseUser } = await import('@/lib/server/auth')
    expect(isAnonymousSupabaseUser({ is_anonymous: true })).toBe(true)
    expect(isAnonymousSupabaseUser({ app_metadata: { provider: 'anonymous' } })).toBe(true)
    expect(isAnonymousSupabaseUser({ app_metadata: { providers: ['anonymous'] } })).toBe(true)
    expect(isAnonymousSupabaseUser({ is_anonymous: false, app_metadata: { provider: 'google', providers: ['google'] } })).toBe(false)
    expect(isAnonymousSupabaseUser({ app_metadata: { providers: ['anonymous', 'email'] } })).toBe(false)
  })
})

// ------------------------------------------------------------------------------------------------- B11 / B12
describe('B11/B12 — server-side voice registry', () => {
  const input = { voiceId: 'clone-abc', label: 'Mine', ownerName: 'Ann', recordingLanguage: 'english' as const, provenance: 'self-recorded' as const, provenanceNote: '', fallbackVoiceId: 'aai-audrey', qualityChecked: true }
  const acct = (userId: string) => ({ userId, kind: 'supabase' as const })

  it('a voice id alone grants nothing: unregistered → not_registered; guests → account_required; library is open', async () => {
    const { authorizeVoice, memoryVoiceStore } = await import('@/lib/server/voice-registry')
    const s = memoryVoiceStore()
    expect(await authorizeVoice(s, acct('u1'), 'clone-abc', 'us')).toEqual({ ok: false, reason: 'not_registered' })
    expect(await authorizeVoice(s, { userId: 'guest-1', kind: 'guest' }, 'clone-abc', 'us')).toEqual({ ok: false, reason: 'account_required' })
    expect(await authorizeVoice(s, { userId: 'guest-1', kind: 'guest' }, 'aai-audrey', 'us')).toMatchObject({ ok: true, kind: 'library' })
  })

  it('registration records full consent server-side and authorizes only the owner', async () => {
    const { authorizeVoice, memoryVoiceStore, registerClonedVoice } = await import('@/lib/server/voice-registry')
    const s = memoryVoiceStore()
    const p = await registerClonedVoice(s, 'u1', input, { region: 'us' })
    expect(p).toMatchObject({ speakerConsent: true, rightsConfirmed: true, biometricTermsAccepted: true, revoked: false })
    expect((await authorizeVoice(s, acct('u1'), 'clone-abc', 'us')).ok).toBe(true)
    // another account that learned the id can neither use it nor claim it
    expect(await authorizeVoice(s, acct('u2'), 'clone-abc', 'us')).toEqual({ ok: false, reason: 'not_registered' })
    await expect(registerClonedVoice(s, 'u2', input, { region: 'us' })).rejects.toMatchObject({ code: 'voice_claimed', status: 409 })
  })

  it('revocation, expiry and region mismatch each block use', async () => {
    const { authorizeVoice, memoryVoiceStore, registerClonedVoice, revokeClonedVoice } = await import('@/lib/server/voice-registry')
    const s = memoryVoiceStore()
    await registerClonedVoice(s, 'u1', input, { region: 'us', now: 1_000 })
    expect(await authorizeVoice(s, acct('u1'), 'clone-abc', 'eu', 2_000)).toEqual({ ok: false, reason: 'region_mismatch' })
    expect(await authorizeVoice(s, acct('u1'), 'clone-abc', 'us', 1_000 + 61 * 86_400_000)).toEqual({ ok: false, reason: 'expired' })
    await revokeClonedVoice(s, 'u1', 'clone-abc')
    expect(await authorizeVoice(s, acct('u1'), 'clone-abc', 'us')).toEqual({ ok: false, reason: 'revoked' })
  })

  it('a fallback voice must be a library voice; library ids cannot be registered', async () => {
    const { memoryVoiceStore, registerClonedVoice } = await import('@/lib/server/voice-registry')
    const s = memoryVoiceStore()
    await expect(registerClonedVoice(s, 'u1', { ...input, fallbackVoiceId: 'clone-other' }, { region: 'us' })).rejects.toMatchObject({ code: 'invalid_fallback' })
    await expect(registerClonedVoice(s, 'u1', { ...input, voiceId: 'aai-audrey' }, { region: 'us' })).rejects.toMatchObject({ code: 'library_voice' })
  })

  it('account deletion tombstones the clone: nobody can ever re-register or use it', async () => {
    const { authorizeVoice, memoryVoiceStore, registerClonedVoice } = await import('@/lib/server/voice-registry')
    const s = memoryVoiceStore()
    await registerClonedVoice(s, 'u1', input, { region: 'us' })
    expect(await s.tombstoneAll('u1')).toEqual(['clone-abc'])
    expect(await authorizeVoice(s, acct('u1'), 'clone-abc', 'us')).toEqual({ ok: false, reason: 'not_registered' })
    await expect(registerClonedVoice(s, 'u2', input, { region: 'us' })).rejects.toMatchObject({ code: 'voice_tombstoned', status: 409 })
  })

  it('REVOICE_CLONE_REGISTRANTS restricts who may bind a clone (verified e-mail only)', async () => {
    const { mayRegisterClone } = await import('@/lib/server/voice-registry')
    expect(mayRegisterClone({ userId: 'u1' })).toBe(true) // unset → any real account
    vi.stubEnv('REVOICE_CLONE_REGISTRANTS', 'owner@example.com, uid-7')
    expect(mayRegisterClone({ userId: 'u1' })).toBe(false)
    expect(mayRegisterClone({ userId: 'uid-7' })).toBe(true)
    expect(mayRegisterClone({ userId: 'u1', email: 'owner@example.com', emailVerified: true })).toBe(true)
    expect(mayRegisterClone({ userId: 'u1', email: 'owner@example.com', emailVerified: false })).toBe(false)
  })

  it('the consent attestation a browser sends to /api/approve is ignored (schema never reads it)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/app/api/approve/route.ts'), 'utf8')
    expect(src).toContain('authorizeVoice(')
    expect(src).not.toMatch(/body\.voice\b/)
    expect(fs.readFileSync(path.resolve(__dirname, '../src/app/api/speak/route.ts'), 'utf8')).toContain('authorizeVoice(')
    expect(fs.readFileSync(path.resolve(__dirname, '../src/app/api/livekit/session/route.ts'), 'utf8')).toContain('authorizeVoice(')
  })
})

// ------------------------------------------------------------------------------------------------- B16
describe('B16 — sealed room metadata', () => {
  it('round-trips, is opaque, and only opens for the same room and secret', async () => {
    const { openRoomMeta, sealRoomMeta } = await import('@/lib/room-seal')
    const blob = await sealRoomMeta(SECRET, ROOM, { ownerIdentity: 'owner-uuid', keyterms: ['Dr Patel'] })
    expect(blob.startsWith('rvm1.')).toBe(true)
    expect(blob).not.toContain('owner-uuid')
    expect(blob).not.toContain('Patel')
    expect(await openRoomMeta(SECRET, ROOM, blob)).toEqual({ ownerIdentity: 'owner-uuid', keyterms: ['Dr Patel'] })
    expect(await openRoomMeta(SECRET, 'rv-ffffffffffffffffffffffff', blob)).toBeNull() // bound to the room
    expect(await openRoomMeta('another-secret-another-secret-0000', ROOM, blob)).toBeNull()
    expect(await openRoomMeta(SECRET, ROOM, blob.slice(0, -4) + 'AAAA')).toBeNull() // tampered
    expect(await openRoomMeta(SECRET, ROOM, JSON.stringify({ ownerIdentity: 'owner-uuid' }))).toBeNull() // plaintext is not trusted
  })

  it('the owner LiveKit identity is opaque, per room, and never the user id', async () => {
    const { ownerParticipantIdentity } = await import('@/lib/server/livekit')
    const a = await ownerParticipantIdentity('owner-uuid', ROOM)
    expect(a).toMatch(/^o-[a-f0-9]{24}$/)
    expect(a).not.toContain('owner-uuid')
    expect(await ownerParticipantIdentity('owner-uuid', 'rv-ffffffffffffffffffffffff')).not.toBe(a)
  })

  it('worker configuration goes to the dispatch metadata, not to room metadata', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/app/api/livekit/session/route.ts'), 'utf8')
    const call = src.slice(src.indexOf('createRoomAndDispatch('))
    const sealedPart = call.slice(0, call.indexOf('// Worker-private'))
    expect(sealedPart).not.toMatch(/keyterms|contextPrompt|voiceId/)
  })
})

// ------------------------------------------------------------------------------------------------- B17
describe('B17 — single-use invites without an owner id', () => {
  it('the link carries no user id; a forged owner or edited exp fails verification', async () => {
    const { signInvite, parseInvite, verifyInvite } = await import('@/lib/server/livekit')
    const inv = await signInvite(ROOM, 'owner-uuid')
    expect(inv.invite).not.toContain('owner-uuid')
    expect(parseInvite(inv.invite)).toMatchObject({ room: ROOM, jti: inv.jti })
    expect(await verifyInvite(inv.invite, 'owner-uuid')).toMatchObject({ room: ROOM, jti: inv.jti })
    expect(await verifyInvite(inv.invite, 'someone-else')).toBeNull()
    const parts = inv.invite.split('.')
    parts[3] = String(Number(parts[3]) + 3_600_000)
    expect(await verifyInvite(parts.join('.'), 'owner-uuid')).toBeNull()
    expect(await verifyInvite(inv.invite, 'owner-uuid', inv.exp + 1)).toBeNull() // expired
  })

  it('an invite is consumed exactly once, even when the instance memory is wiped', async () => {
    const { consumeInvite, resetInviteMemory } = await import('@/lib/server/invites')
    rooms.set(ROOM, baseMeta())
    expect(await consumeInvite('a'.repeat(24), ROOM, Date.now() + 60_000)).toBe('ok')
    expect(await consumeInvite('a'.repeat(24), ROOM, Date.now() + 60_000)).toBe('used')
    resetInviteMemory() // "another serverless instance": only the sealed room metadata remains
    expect(await consumeInvite('a'.repeat(24), ROOM, Date.now() + 60_000)).toBe('used')
    expect(await consumeInvite('b'.repeat(24), ROOM, Date.now() + 60_000)).toBe('ok') // a fresh invite still works
  })

  it('fails CLOSED when the room (and so the owner) cannot be read', async () => {
    const { consumeInvite } = await import('@/lib/server/invites')
    expect(await consumeInvite('c'.repeat(24), ROOM, Date.now() + 60_000)).toBe('unavailable')
  })
})

// ------------------------------------------------------------------------------------------------- B15
describe('B15 — phone bind guard', () => {
  it('a WRONG code costs the caller; the call scope locks after 5 failures', async () => {
    const { BIND_LIMITS, bindAllowed, recordBindFailure } = await import('@/lib/server/phone-guard')
    const call = 'call-aaa'
    for (let i = 0; i < BIND_LIMITS.call.limit - 1; i++) {
      expect((await bindAllowed(call, `sip-${i}`)).ok).toBe(true)
      expect(await recordBindFailure(call, `sip-${i}`)).toEqual([])
    }
    expect(await recordBindFailure(call, 'sip-last')).toContain('call')
    expect(await bindAllowed(call, 'sip-new')).toEqual({ ok: false, scope: 'call' })
    expect((await bindAllowed('call-other', 'sip-fresh')).ok).toBe(true) // other calls are unaffected
  })

  it('redialling (new call room) does not reset the per-caller scope', async () => {
    const { BIND_LIMITS, bindAllowed, recordBindFailure } = await import('@/lib/server/phone-guard')
    for (let i = 0; i < BIND_LIMITS.identity.limit; i++) await recordBindFailure(`call-r${i}`, 'sip-attacker')
    expect(await bindAllowed('call-brand-new', 'sip-attacker')).toEqual({ ok: false, scope: 'identity' })
  })

  it('a distributed attacker trips the global scope', async () => {
    const { BIND_LIMITS, bindAllowed, recordBindFailure } = await import('@/lib/server/phone-guard')
    for (let i = 0; i < BIND_LIMITS.global.limit; i++) await recordBindFailure(`call-g${i}`, `sip-g${i}`)
    expect(await bindAllowed('call-clean', 'sip-clean')).toEqual({ ok: false, scope: 'global' })
  })

  it('keys are keyed hashes — no caller number or room name is stored in clear', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/lib/server/phone-guard.ts'), 'utf8')
    expect(src).toContain('hmacSha256Hex')
  })

  it('burnAllPairCodes clears every live code so guessing cannot keep one alive', async () => {
    const { burnAllPairCodes, livekitRoomStore, storePairCode } = await import('@/lib/server/phone-store')
    rooms.set(ROOM, baseMeta('u1'))
    rooms.set('rv-bbbbbbbbbbbbbbbbbbbbbbbb', baseMeta('u2'))
    const store = await livekitRoomStore()
    await storePairCode(store, 'u1', ROOM, 'h1', Date.now() + 60_000)
    await storePairCode(store, 'u2', 'rv-bbbbbbbbbbbbbbbbbbbbbbbb', 'h2', Date.now() + 60_000)
    expect(await burnAllPairCodes(store)).toBe(2)
    expect([...rooms.values()].every((m) => !m.phonePair)).toBe(true)
  })

  it('the bind route checks the guard BEFORE the code lookup and counts misses', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/app/api/phone/bind/route.ts'), 'utf8')
    expect(src.indexOf('bindAllowed(')).toBeGreaterThan(-1)
    expect(src.indexOf('bindAllowed(')).toBeLessThan(src.indexOf('lookupPairCode('))
    expect(src).toContain('recordBindFailure(')
    expect(src).toContain('burnAllPairCodes(')
  })
})

// ------------------------------------------------------------------------------------------------- B18
describe('B18 — minimal public status', () => {
  it('userMeters exposes only the caller\'s daily meters (no lifetime / spendable / project figures)', async () => {
    const { BudgetLedger } = await import('@/lib/budget')
    const { OPERATOR_ONLY_KEYS, userMeters } = await import('@/lib/status-view')
    const snap = new BudgetLedger().snapshot()
    const pub = JSON.stringify(userMeters(snap))
    for (const k of OPERATOR_ONLY_KEYS) expect(pub).not.toContain(`"${k}"`)
    expect(userMeters(snap).usd).toEqual({ today: snap.usd.today, todayLimit: snap.usd.todayLimit })
  })

  it('the export route no longer returns the raw ledger snapshot (it carried lifetime/spendable project credit)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/app/api/account/export/route.ts'), 'utf8')
    expect(src).toContain('userMeters(ledgerFor(id.userId).snapshot())')
    expect(src).not.toMatch(/usage:\s*ledgerFor\(id\.userId\)\.snapshot\(\)/)
  })

  it('the route puts userId, project budget, spend store, secret source and model under `operator` only', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/app/api/status/route.ts'), 'utf8')
    // Only the response BODY literal is public (id.userId is legitimately used server-side to pick the caller's ledger).
    const publicBody = src.slice(src.indexOf('const body: PublicStatus = {'), src.indexOf('if (isOperator(id))'))
    expect(publicBody).toContain('identity: { kind: id.kind }')
    expect(publicBody).not.toMatch(/\buserId\s*:/)
    for (const leak of ['projectLedger', 'spendStoreStatus', 'approvalSecretSource', 'groqModel', 'lifetime', 'spendable']) expect(publicBody).not.toContain(leak)
    expect(src.slice(src.indexOf('if (isOperator(id))'))).toContain('projectLedger')
  })
})

// ------------------------------------------------------------------------------------------------- B19
describe('B19 — real account deletion and export', () => {
  it('without a durable store it tombstones voices, closes live rooms and reports every step', async () => {
    const { memoryVoiceStore, registerClonedVoice } = await import('@/lib/server/voice-registry')
    vi.stubEnv('LIVEKIT_URL', 'wss://x.livekit.cloud')
    vi.stubEnv('LIVEKIT_API_KEY', 'k')
    vi.stubEnv('LIVEKIT_API_SECRET', 's')
    const id = { userId: 'demo-1', kind: 'local-demo' as const }
    await registerClonedVoice(memoryVoiceStore(), 'demo-1', { voiceId: 'clone-del', label: 'x', ownerName: 'A', recordingLanguage: 'english', provenance: 'self-recorded', provenanceNote: '', fallbackVoiceId: 'aai-audrey', qualityChecked: true }, { region: 'us' })
    rooms.set(ROOM, { ...baseMeta('demo-1'), startedAt: Date.now() - 120_000, sttMinutes: 20 })
    const { deleteAccount } = await import('@/lib/server/account')
    const r = await deleteAccount(id)
    expect(r.voiceIds).toEqual(['clone-del'])
    expect(r.steps.map((s) => s.step)).toEqual(expect.arrayContaining(['tombstone_voices', 'close_rooms']))
    expect(r.steps.every((s) => s.ok)).toBe(true)
    expect(rooms.has(ROOM)).toBe(false) // STT billing stops
    expect(await memoryVoiceStore().claim('clone-del')).toBe('tombstoned')
  })

  it('every user-owned table is covered by delete and the delete route demands a typed confirmation', async () => {
    const { USER_TABLES, EXPORT_TABLES } = await import('@/lib/server/account')
    for (const t of ['voice_profiles', 'biometric_consents', 'phrases', 'conversation_sessions', 'phone_calls', 'audit_events']) expect(USER_TABLES).toContain(t)
    expect(EXPORT_TABLES).toContain('voice_profiles')
    expect(USER_TABLES).not.toContain('budget_reservations' as never) // spend history must outlive the user
    const route = fs.readFileSync(path.resolve(__dirname, '../src/app/api/account/delete/route.ts'), 'utf8')
    expect(route).toContain("z.literal('DELETE MY ACCOUNT')")
  })

  it('the delete route refuses without confirmation (no side effects)', async () => {
    const { POST } = await import('@/app/api/account/delete/route')
    const res = await POST(new Request('http://x/api/account/delete', { method: 'POST', body: '{}' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('confirmation_required')
  })
})

// ------------------------------------------------------------------------------------------------- migration
describe('migration 0004 matches what the code relies on', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/0004_security_consent.sql'), 'utf8')
  it('declares every RPC / table / column the server calls', () => {
    for (const name of ['consume_invite', 'guard_hit', 'guard_count', 'settle_open_reservations', 'voice_tombstones', 'invite_uses', 'guard_events', 'voice_profiles_one_claim']) expect(sql).toContain(name)
    for (const col of ['speaker_consent', 'rights_confirmed', 'biometric_terms_accepted', 'quality_checked', 'consent_at', 'provider_expires_at', 'owner_name']) expect(sql).toContain(col)
  })
  it('clients can no longer write the voice registry; RPCs are service-role only', () => {
    expect(sql).toMatch(/drop policy if exists owner_all on public\.voice_profiles/)
    expect(sql).toMatch(/create policy owner_read on public\.voice_profiles for select/)
    for (const fn of ['consume_invite', 'guard_hit', 'guard_count', 'settle_open_reservations']) expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}`))
  })
})
