/**
 * Open item — phone pairing across serverless instances.
 * The pair code / call reservation must survive a request landing on a DIFFERENT instance: the
 * per-instance memory is wiped between steps and only the (mocked) LiveKit room metadata remains.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomMetadata } from '@/lib/server/livekit'
import { hmacSha256Hex } from '@/lib/hash'
import { hashPairCode, verifyPhoneBinding } from '@/lib/phone'
import { SECRET } from './helpers'

const rooms = new Map<string, RoomMetadata>()
vi.mock('@/lib/server/livekit', () => ({
  getRoomMeta: async (room: string) => (rooms.has(room) ? structuredClone(rooms.get(room)!) : null),
  listAllOwnerRooms: async () => [...rooms].map(([room, meta]) => ({ room, meta: structuredClone(meta) })),
  updateRoomMeta: async (room: string, meta: RoomMetadata) => {
    if (!rooms.has(room)) throw new Error('room not found')
    rooms.set(room, structuredClone(meta))
  },
}))

const ROOM = 'rv-0123456789abcdef01234567'
const OWNER = 'user-1'
const meta = (): RoomMetadata => ({ ownerIdentity: OWNER, conversationId: 'c1', generation: 0, mode: 'remote', voiceId: 'aai-audrey', outputLanguage: 'english', inputLanguages: [], keyterms: [], maxSessionMinutes: 20 })

async function workerReq(path: string, body: unknown) {
  const raw = JSON.stringify(body)
  const ts = Date.now()
  const sig = await hmacSha256Hex(SECRET, `worker:${ts}:${raw}`)
  return new Request(`http://x${path}`, { method: 'POST', body: raw, headers: { 'x-revoice-worker': `${ts}.${sig}`, 'content-type': 'application/json' } })
}

/** Simulate "the next request lands on another serverless instance". */
async function otherInstance() {
  const { rv } = await import('@/lib/server/state')
  rv().phoneCodes.clear()
  rv().phoneReservations.clear()
  rv().sessions.clear()
}

describe('phone pairing works across instances (LiveKit room metadata store)', () => {
  beforeEach(() => {
    rooms.clear()
    rooms.set(ROOM, meta())
    vi.stubEnv('REVOICE_APPROVAL_SECRET', SECRET)
    vi.stubEnv('REVOICE_PHONE_INBOUND_ENABLED', 'true')
    vi.stubEnv('LIVEKIT_URL', 'wss://example.livekit.cloud')
    vi.stubEnv('LIVEKIT_API_KEY', 'k')
    vi.stubEnv('LIVEKIT_API_SECRET', 's')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('code issued on instance A binds on instance B, is single use, and settles on instance C', async () => {
    const store = await (await import('@/lib/server/phone-store')).livekitRoomStore()
    const { storePairCode } = await import('@/lib/server/phone-store')
    const key = await hashPairCode(SECRET, '424242')
    expect(await storePairCode(store, OWNER, ROOM, key, Date.now() + 60_000)).toBe(true)
    expect(JSON.stringify(rooms.get(ROOM))).not.toContain('424242') // only the keyed hash is stored

    await otherInstance()
    const { POST: bind } = await import('@/app/api/phone/bind/route')
    const res = await bind(await workerReq('/api/phone/bind', { code: '424242', identity: 'sip_caller', callRoom: 'call-abc' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.room).toBe(ROOM)
    expect(await verifyPhoneBinding(SECRET, body.binding, { room: ROOM, identity: 'sip_caller' })).toBe(body.maxMinutes)
    expect(rooms.get(ROOM)!.phonePair).toBeNull()
    expect(rooms.get(ROOM)!.phoneCall).toMatchObject({ identity: 'sip_caller', minutes: body.maxMinutes })

    // single use — even on yet another instance
    await otherInstance()
    const again = await bind(await workerReq('/api/phone/bind', { code: '424242', identity: 'sip_caller', callRoom: 'call-abc' }))
    expect(again.status).toBe(403)

    // settlement on a third instance reads the reservation from metadata
    await otherInstance()
    const { POST: usage } = await import('@/app/api/phone/usage/route')
    const u = await usage(await workerReq('/api/phone/usage', { room: ROOM, minutes: 3.2 }))
    expect(u.status).toBe(200)
    expect((await u.json()).minutes).toBe(4) // started minutes are billed
    expect(rooms.get(ROOM)!.phoneCall).toBeNull()
    const u2 = await usage(await workerReq('/api/phone/usage', { room: ROOM, minutes: 3.2 }))
    expect((await u2.json()).minutes).toBe(0) // idempotent: nothing left to settle
  })

  it('wrong guesses are bounded across instances and expired codes are rejected', async () => {
    const ps = await import('@/lib/server/phone-store')
    const store = await ps.livekitRoomStore()
    const key = await hashPairCode(SECRET, '111111')
    await ps.storePairCode(store, OWNER, ROOM, key, Date.now() + 60_000)
    for (let i = 0; i < 3; i++) expect((await ps.lookupPairCode(store, key)).ok).toBe(true)
    expect((await ps.lookupPairCode(store, key)).ok).toBe(false) // 4th attempt → code destroyed
    expect(rooms.get(ROOM)!.phonePair).toBeNull()

    await ps.storePairCode(store, OWNER, ROOM, key, Date.now() - 1)
    expect((await ps.lookupPairCode(store, key)).ok).toBe(false)
    expect(rooms.get(ROOM)!.phonePair).toBeNull()
  })

  it('a code cannot be stored on someone else\'s room; revoke clears every code of the owner', async () => {
    const ps = await import('@/lib/server/phone-store')
    const store = await ps.livekitRoomStore()
    expect(await ps.storePairCode(store, 'intruder', ROOM, 'h', Date.now() + 60_000)).toBe(false)
    expect(await ps.storePairCode(store, OWNER, 'rv-ffffffffffffffffffffffff', 'h', Date.now() + 60_000)).toBe(false) // room gone
    await ps.storePairCode(store, OWNER, ROOM, 'h', Date.now() + 60_000)
    expect(await ps.revokePairCodes(store, OWNER)).toBe(1)
    expect(rooms.get(ROOM)!.phonePair).toBeNull()
  })

  it('an unknown code is rejected with JSON 403; a bad worker signature with 401', async () => {
    const { POST: bind } = await import('@/app/api/phone/bind/route')
    const r = await bind(await workerReq('/api/phone/bind', { code: '999999', identity: 'sip_x', callRoom: 'call-x' }))
    expect(r.status).toBe(403)
    expect((await r.json()).error).toBe('invalid_code')
    const forged = new Request('http://x/api/phone/bind', { method: 'POST', body: '{}', headers: { 'x-revoice-worker': `${Date.now()}.deadbeef` } })
    expect((await bind(forged)).status).toBe(401)
  })
})
