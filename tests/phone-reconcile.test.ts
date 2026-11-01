import { describe, expect, it } from 'vitest'
import { allowedCallMinutes, hashPairCode, isPairCode, newPairCode, phoneBindingString, signPhoneBinding, verifyPhoneBinding } from '@/lib/phone'
import { reconcile } from '@/lib/reconcile'
import { verifyWorkerAuth } from '@/lib/server/worker-auth'
import { hmacSha256Hex } from '@/lib/hash'
import { SECRET } from './helpers'

describe('phone bridge', () => {
  it('pair codes are 6 digits and stored hashed', async () => {
    for (let i = 0; i < 50; i++) expect(isPairCode(newPairCode())).toBe(true)
    expect(isPairCode('12345')).toBe(false)
    const h = await hashPairCode(SECRET, '123456')
    expect(h).not.toContain('123456')
    expect(h).toHaveLength(64)
  })
  it('40-minute monthly cap, 15 per call, integer minutes', () => {
    expect(allowedCallMinutes(0)).toBe(15)
    expect(allowedCallMinutes(30)).toBe(10)
    expect(allowedCallMinutes(39.5)).toBe(0)
    expect(allowedCallMinutes(40)).toBe(0)
    expect(allowedCallMinutes(55)).toBe(0)
  })
  it('binding verifies only for the same room + identity, unexpired, untampered', async () => {
    const now = Date.now()
    const raw = await signPhoneBinding(SECRET, 'rv-room', 'sip_1', now + 60_000, 10)
    expect(await verifyPhoneBinding(SECRET, raw, { room: 'rv-room', identity: 'sip_1' }, now)).toBe(10)
    expect(await verifyPhoneBinding(SECRET, raw, { room: 'rv-other', identity: 'sip_1' }, now)).toBeNull()
    expect(await verifyPhoneBinding(SECRET, raw, { room: 'rv-room', identity: 'sip_2' }, now)).toBeNull()
    expect(await verifyPhoneBinding(SECRET, raw, { room: 'rv-room', identity: 'sip_1' }, now + 120_000)).toBeNull()
    const tampered = JSON.stringify({ ...JSON.parse(raw), maxMinutes: 15 })
    expect(await verifyPhoneBinding(SECRET, tampered, { room: 'rv-room', identity: 'sip_1' }, now)).toBeNull()
    expect(await verifyPhoneBinding('other', raw, { room: 'rv-room', identity: 'sip_1' }, now)).toBeNull()
    expect(await verifyPhoneBinding(SECRET, 'not json', { room: 'rv-room', identity: 'sip_1' }, now)).toBeNull()
  })
  it('binding string format matches the Python worker', () => {
    expect(phoneBindingString('r', 'i', 123, 10)).toBe('phone:r:i:123:10')
  })
  it('worker auth: valid once, rejects replay, skew and forgery', async () => {
    const now = Date.now()
    const body = '{"code":"123456"}'
    const header = `${now}.${await hmacSha256Hex(SECRET, `worker:${now}:${body}`)}`
    expect(await verifyWorkerAuth(SECRET, header, body, now)).toBe(true)
    expect(await verifyWorkerAuth(SECRET, header, body, now)).toBe(false) // replay
    const old = now - 120_000
    expect(await verifyWorkerAuth(SECRET, `${old}.${await hmacSha256Hex(SECRET, `worker:${old}:${body}`)}`, body, now)).toBe(false)
    expect(await verifyWorkerAuth(SECRET, `${now}.${'0'.repeat(64)}`, body, now)).toBe(false)
    expect(await verifyWorkerAuth(SECRET, null, body, now)).toBe(false)
  })
})

describe('provider reconciliation', () => {
  it('classifies drift', () => {
    expect(reconcile(1, null).status).toBe('no_provider_figure')
    expect(reconcile(1, 1.05).status).toBe('ok')
    expect(reconcile(1, 2).status).toBe('under_counted')
    expect(reconcile(2, 1).status).toBe('over_counted')
    expect(reconcile(0.01, 0.1).status).toBe('ok') // tiny absolute drift is not material
  })
})
