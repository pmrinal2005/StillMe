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

// ------------------------------------------------------------------------------------------------- B13 / device identity
describe('B13 — operator token fails closed (no accounts)', () => {
  const opReq = (token?: string, ip = '5.5.5.5') => new Request('http://x/api/reconcile', { headers: { ...(token ? { 'x-revoice-operator': token } : {}), 'x-forwarded-for': ip } })

  it('with no REVOICE_OPERATOR_TOKEN configured nobody is an operator, whatever they send', async () => {
    vi.stubEnv('REVOICE_OPERATOR_TOKEN', '')
    const { isOperator } = await import('@/lib/server/auth')
    expect(await isOperator(opReq('anything'))).toBe(false)
    expect(await isOperator(opReq())).toBe(false)
  })

  it('only the exact token works; a missing or wrong one does not', async () => {
    vi.stubEnv('REVOICE_OPERATOR_TOKEN', 'correct-horse-battery-staple')
    const { isOperator } = await import('@/lib/server/auth')
    expect(await isOperator(opReq('correct-horse-battery-staple'))).toBe(true)
    expect(await isOperator(opReq('correct-horse-battery-stapl'))).toBe(false)
    expect(await isOperator(opReq())).toBe(false)
  })

  it('online guessing is rate limited: after 8 wrong tries even the right token is refused from that client', async () => {
    vi.stubEnv('REVOICE_OPERATOR_TOKEN', 'right-token-value')
    const { isOperator } = await import('@/lib/server/auth')
    for (let i = 0; i < 8; i++) expect(await isOperator(opReq(`wrong-${i}`, '6.6.6.6'))).toBe(false)
    expect(await isOperator(opReq('right-token-value', '6.6.6.6'))).toBe(false) // locked out
    expect(await isOperator(opReq('right-token-value', '7.7.7.7'))).toBe(true) // another client is unaffected
  })

  it('the reconcile seed is clamped so one typo cannot lock every user out', async () => {
    const { clampReconcileSeed } = await import('@/lib/reconcile')
    const { LIMITS } = await import('@/lib/budget')
    expect(clampReconcileSeed(100_000)).toBe(LIMITS.assembly.totalCreditUsd)
    expect(clampReconcileSeed(-5)).toBe(0)
    expect(clampReconcileSeed(Number.NaN)).toBe(0)
    expect(clampReconcileSeed(1.5)).toBe(1.5)
  })

  it('the routes ask for the operator header, never an account', () => {
    for (const f of ['reconcile', 'status']) {
      const src = fs.readFileSync(path.resolve(__dirname, `../src/app/api/${f}/route.ts`), 'utf8')
      expect(src).toMatch(/isOperator\(req\)/)
    }
  })
})

describe('Device identity — signed cookie, deterministic uuid, no sign-in', () => {
  it('signs and verifies device keys; forged, edited or malformed keys are rejected', async () => {
    const { deviceKeyFor, parseDeviceKey } = await import('@/lib/server/auth')
    const id = 'a'.repeat(32)
    const key = await deviceKeyFor(id)
    expect(key).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{64}$/)
    expect(await parseDeviceKey(key)).toBe(id)
    expect(await parseDeviceKey(`${'b'.repeat(32)}.${key.split('.')[1]}`)).toBeNull() // signature of another id
    expect(await parseDeviceKey(`${id}.${'0'.repeat(64)}`)).toBeNull()
    expect(await parseDeviceKey(`${id}.${key.split('.')[1]}.extra`)).toBeNull()
    expect(await parseDeviceKey('not-a-key')).toBeNull()
    expect(await parseDeviceKey('')).toBeNull()
    expect(await parseDeviceKey(null)).toBeNull()
    expect(await parseDeviceKey(`${'Z'.repeat(32)}.${key.split('.')[1]}`)).toBeNull()
  })

  it('a different secret invalidates every key (the secret is the trust root)', async () => {
    const { deviceKeyFor, parseDeviceKey } = await import('@/lib/server/auth')
    const key = await deviceKeyFor('c'.repeat(32))
    vi.stubEnv('REVOICE_APPROVAL_SECRET', SECRET + '-rotated')
    expect(await parseDeviceKey(key)).toBeNull()
  })

  it('maps a device id to a stable RFC-4122 uuid (durable tables need a real uuid) and different ids to different uuids', async () => {
    const { userIdForDevice } = await import('@/lib/server/auth')
    const a = await userIdForDevice('a'.repeat(32))
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(await userIdForDevice('a'.repeat(32))).toBe(a)
    expect(await userIdForDevice('b'.repeat(32))).not.toBe(a)
    expect(a).not.toContain('a'.repeat(12)) // the uuid does not leak the device id
  })

  it('there is no Supabase auth, OAuth, e-mail link or anonymous sign-in anywhere in the server identity code', () => {
    const raw = fs.readFileSync(path.resolve(__dirname, '../src/lib/server/auth.ts'), 'utf8')
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') // comments may explain what is NOT here
    expect(code).not.toMatch(/supabase|oauth|getUser|signIn|access.?token|bearer/i)
  })
})

// ------------------------------------------------------------------------------------------------- B11 / B12
describe('B11/B12 — server-side voice registry', () => {
  const input = { voiceId: 'clone-abc', label: 'Mine', ownerName: 'Ann', recordingLanguage: 'english' as const, provenance: 'self-recorded' as const, provenanceNote: '', fallbackVoiceId: 'aai-audrey', qualityChecked: true }
  const acct = (userId: string) => ({ userId })

  it('a voice id alone grants nothing: unregistered → not_registered; library is open', async () => {
    const { authorizeVoice, memoryVoiceStore } = await import('@/lib/server/voice-registry')
    const s = memoryVoiceStore()
    expect(await authorizeVoice(s, acct('u1'), 'clone-abc', 'us')).toEqual({ ok: false, reason: 'not_registered' })
    expect(await authorizeVoice(s, acct('u-other'), 'aai-audrey', 'us')).toMatchObject({ ok: true, kind: 'library' })
  })

  it('registration records full consent server-side and authorizes only the owner', async () => {
    const { authorizeVoice, memoryVoiceStore, registerClonedVoice } = await import('@/lib/server/voice-registry')
    const s = memoryVoiceStore()
    const p = await registerClonedVoice(s, 'u1', input, { region: 'us' })
    expect(p).toMatchObject({ speakerConsent: true, rightsConfirmed: true, biometricTermsAccepted: true, revoked: false })
    expect((await authorizeVoice(s, acct('u1'), 'clone-abc', 'us')).ok).toBe(true)
    // another DEVICE that learned the id can neither use it nor claim it
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

  it('deleting a device\'s data tombstones the clone: nobody can ever re-register or use it', async () => {
    const { authorizeVoice, memoryVoiceStore, registerClonedVoice } = await import('@/lib/server/voice-registry')
    const s = memoryVoiceStore()
    await registerClonedVoice(s, 'u1', input, { region: 'us' })
    expect(await s.tombstoneAll('u1')).toEqual(['clone-abc'])
    expect(await authorizeVoice(s, acct('u1'), 'clone-abc', 'us')).toEqual({ ok: false, reason: 'not_registered' })
    await expect(registerClonedVoice(s, 'u2', input, { region: 'us' })).rejects.toMatchObject({ code: 'voice_tombstoned', status: 409 })
  })

  it('REVOICE_CLONE_PASSCODE gates registering a clone (unset = open); the check is constant-time and header based', async () => {
    const { mayRegisterClone } = await import('@/lib/server/auth')
    const reqWith = (code?: string) => new Request('http://x/api/voices', { method: 'POST', headers: code ? { 'x-revoice-clone-passcode': code } : {} })
    expect(await mayRegisterClone(reqWith())).toBe(true) // unset -> any device may register
    vi.stubEnv('REVOICE_CLONE_PASSCODE', 'owner-pass')
    expect(await mayRegisterClone(reqWith())).toBe(false)
    expect(await mayRegisterClone(reqWith('nope'))).toBe(false)
    expect(await mayRegisterClone(reqWith('owner-pass'))).toBe(true)
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
    const src = fs.readFileSync(path.resolve(__dirname, '../src/app/api/data/export/route.ts'), 'utf8')
    expect(src).toContain('userMeters(ledgerFor(id.userId).snapshot())')
    expect(src).not.toMatch(/usage:\s*ledgerFor\(id\.userId\)\.snapshot\(\)/)
  })

  it('the route puts userId, project budget, spend store, secret source and model under `operator` only', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/app/api/status/route.ts'), 'utf8')
    // Only the response BODY literal is public (id.userId is legitimately used server-side to pick the caller's ledger).
    const publicBody = src.slice(src.indexOf('const body: PublicStatus = {'), src.indexOf('if (operator)'))
    expect(publicBody).not.toContain('identity')
    expect(publicBody).not.toMatch(/\buserId\s*:/)
    for (const leak of ['projectLedger', 'spendStoreStatus', 'approvalSecretSource', 'groqModel', 'lifetime', 'spendable']) expect(publicBody).not.toContain(leak)
    expect(src.slice(src.indexOf('if (operator)'))).toContain('projectLedger')
  })
})

// ------------------------------------------------------------------------------------------------- B19
describe('B19 — real deletion of a device\'s server data, and export', () => {
  it('without a durable store it tombstones voices, closes live rooms and reports every step', async () => {
    const { memoryVoiceStore, registerClonedVoice } = await import('@/lib/server/voice-registry')
    vi.stubEnv('LIVEKIT_URL', 'wss://x.livekit.cloud')
    vi.stubEnv('LIVEKIT_API_KEY', 'k')
    vi.stubEnv('LIVEKIT_API_SECRET', 's')
    const id = { userId: 'demo-1', deviceId: 'd'.repeat(32) }
    await registerClonedVoice(memoryVoiceStore(), 'demo-1', { voiceId: 'clone-del', label: 'x', ownerName: 'A', recordingLanguage: 'english', provenance: 'self-recorded', provenanceNote: '', fallbackVoiceId: 'aai-audrey', qualityChecked: true }, { region: 'us' })
    rooms.set(ROOM, { ...baseMeta('demo-1'), startedAt: Date.now() - 120_000, sttMinutes: 20 })
    const { deleteDeviceData } = await import('@/lib/server/account')
    const r = await deleteDeviceData(id)
    expect(r.voiceIds).toEqual(['clone-del'])
    expect(r.steps.map((s) => s.step)).toEqual(expect.arrayContaining(['tombstone_voices', 'close_rooms']))
    expect(r.steps.every((s) => s.ok)).toBe(true)
    expect(rooms.has(ROOM)).toBe(false) // STT billing stops
    expect(await memoryVoiceStore().claim('clone-del')).toBe('tombstoned')
  })

  it('every device-owned table is covered by delete (voice_profiles before biometric_consents) and the delete route demands a typed confirmation', async () => {
    const { USER_TABLES, EXPORT_TABLES } = await import('@/lib/server/account')
    for (const t of ['voice_profiles', 'biometric_consents', 'phrases', 'conversation_sessions', 'phone_calls', 'audit_events']) expect(USER_TABLES).toContain(t)
    expect(EXPORT_TABLES).toContain('voice_profiles')
    expect(USER_TABLES).not.toContain('budget_reservations' as never) // spend history must outlive the device
    expect(USER_TABLES.indexOf('voice_profiles')).toBeLessThan(USER_TABLES.indexOf('biometric_consents')) // append-only trigger (0005)
    const route = fs.readFileSync(path.resolve(__dirname, '../src/app/api/data/delete/route.ts'), 'utf8')
    expect(route).toContain("z.literal('DELETE MY DATA')")
  })

  it('the delete route refuses without confirmation (no side effects)', async () => {
    const { POST } = await import('@/app/api/data/delete/route')
    const res = await POST(new Request('http://x/api/data/delete', { method: 'POST', body: '{}' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('confirmation_required')
  })

  it('the old /api/account/* routes are gone', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../src/app/api/account'))).toBe(false)
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

describe('migration 0007 (no sign-in)', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/0007_no_signin.sql'), 'utf8')
  it('drops every foreign key to auth.users, because device uuids are not auth users', () => {
    expect(sql).toContain("c.confrelid = 'auth.users'::regclass")
    expect(sql).toMatch(/drop constraint %I/)
  })
  it('removes every browser policy and privilege: the database is reached only from the server', () => {
    expect(sql).toMatch(/revoke all on public\.%I from anon, authenticated/)
    expect(sql).toMatch(/drop policy if exists %I/)
    expect(sql).toMatch(/revoke all on all functions in schema public from anon, authenticated/)
  })
  it('is idempotent (only drop-if-exists / revoke / comment statements)', () => {
    expect(sql).not.toMatch(/create table|insert into|alter table [^;]* add constraint/i)
  })
})
