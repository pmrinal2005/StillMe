/**
 * Regression tests for the first four critical bugs:
 *  B1 LiveKit canPublishSources string → TrackSource enum (toJwt threw → partner join/tabletop 500)
 *  B2 per-instance random approval secret → stable explicit/derived secret shared by web + worker
 *  B3 STT minutes never released on end/failure → release/settle
 *  B4 session state in serverless memory → signed session ticket
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessToken, TrackSource } from 'livekit-server-sdk'
import { BudgetLedger, dayKey, LIMITS } from '@/lib/budget'
import { signSessionTicket, ticketExpiry, TICKET_SETTLE_WINDOW_MS, usedSttMinutes, verifySessionTicket } from '@/lib/session-ticket'
import { SECRET } from './helpers'

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0)

// ------------------------------------------------------------------ B1
describe('B1 — LiveKit grants use the TrackSource enum', () => {
  const LK_KEY = 'APIkey'
  const LK_SECRET = 'lk-secret-0123456789abcdef0123456789abcdef'

  it('reproduces the original failure: a string source makes toJwt() throw', async () => {
    const at = new AccessToken(LK_KEY, LK_SECRET, { identity: 'x' })
    at.addGrant({ room: 'r', roomJoin: true, canPublishSources: ['microphone' as never] })
    await expect(at.toJwt()).rejects.toThrow()
  })

  describe('with the real token helpers', () => {
    beforeEach(() => {
      vi.stubEnv('LIVEKIT_URL', 'wss://example.livekit.cloud')
      vi.stubEnv('LIVEKIT_API_KEY', LK_KEY)
      vi.stubEnv('LIVEKIT_API_SECRET', LK_SECRET)
    })
    afterEach(() => vi.unstubAllEnvs())

    const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())

    it('partnerToken mints a JWT allowing only microphone publishing', async () => {
      const { partnerToken } = await import('@/lib/server/livekit')
      const { token, identity } = await partnerToken({ room: 'rv-aaaaaaaaaaaaaaaaaaaaaaaa', label: 'Partner' })
      const c = claims(token)
      expect(identity).toMatch(/^partner-/)
      expect(c.video.canPublishSources).toEqual(['microphone'])
      expect(c.video.canPublishData).toBe(false)
    })

    it('ownerToken works in tabletop (mic) and partner-link (no publish) modes', async () => {
      const { ownerToken } = await import('@/lib/server/livekit')
      const tab = claims(await ownerToken({ identity: 'user-1', room: 'rv-aaaaaaaaaaaaaaaaaaaaaaaa', mode: 'tabletop' }))
      expect(tab.video.canPublish).toBe(true)
      expect(tab.video.canPublishSources).toEqual(['microphone'])
      const link = claims(await ownerToken({ identity: 'user-1', room: 'rv-aaaaaaaaaaaaaaaaaaaaaaaa', mode: 'partner-link' }))
      expect(link.video.canPublish).toBe(false)
    })

    it('the enum value is the one the SDK expects', () => {
      expect(TrackSource.MICROPHONE).toBe(2)
    })
  })
})

// ------------------------------------------------------------------ B2
describe('B2 — stable approval secret across instances (and the worker)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('shared test vector: derived secret matches worker/revoice_worker/config.py', async () => {
    const { deriveApprovalSecret } = await import('@/lib/server/env')
    // Same vector is asserted in worker/tests/test_worker.py::test_derived_approval_secret_matches_web
    expect(deriveApprovalSecret('lk-secret-example')).toBe('5961b2967a75d69fd5fdf6066fcf6e965be7d6139910ded75c71686bc06ce2fe')
  })

  it('explicit REVOICE_APPROVAL_SECRET wins', async () => {
    vi.stubEnv('REVOICE_APPROVAL_SECRET', 'explicit-secret')
    vi.stubEnv('LIVEKIT_API_SECRET', 'lk')
    const { env } = await import('@/lib/server/env')
    expect(env.approvalSecret()).toBe('explicit-secret')
    expect(env.approvalSecretSource()).toBe('explicit')
  })

  it('without it, two fresh "instances" derive the SAME secret from LIVEKIT_API_SECRET', async () => {
    vi.stubEnv('REVOICE_APPROVAL_SECRET', '')
    vi.stubEnv('LIVEKIT_API_SECRET', 'lk-secret-example')
    const a = (await import('@/lib/server/env')).env.approvalSecret()
    vi.resetModules() // simulate a cold start on another serverless instance
    const b = (await import('@/lib/server/env')).env.approvalSecret()
    expect(a).toBe(b)
    expect(a).toBe('5961b2967a75d69fd5fdf6066fcf6e965be7d6139910ded75c71686bc06ce2fe')
    const { providerStatus } = await import('@/lib/server/env')
    expect(providerStatus().approvalSecretConfigured).toBe(true)
    expect(providerStatus().approvalSecretSource).toBe('derived:LIVEKIT_API_SECRET')
  })

  it('falls back to ASSEMBLYAI_API_KEY when LiveKit is not configured', async () => {
    vi.stubEnv('REVOICE_APPROVAL_SECRET', '')
    vi.stubEnv('LIVEKIT_API_SECRET', '')
    vi.stubEnv('ASSEMBLYAI_API_KEY', 'aai-key')
    const { env } = await import('@/lib/server/env')
    expect(env.approvalSecretSource()).toBe('derived:ASSEMBLYAI_API_KEY')
  })

  it('production with no secret material fails closed (never a per-instance random secret)', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('REVOICE_APPROVAL_SECRET', '')
    vi.stubEnv('LIVEKIT_API_SECRET', '')
    vi.stubEnv('ASSEMBLYAI_API_KEY', '')
    const { env } = await import('@/lib/server/env')
    expect(() => env.approvalSecret()).toThrow(/approval_secret_unavailable/)
    expect(env.approvalSecretSource()).toBe('missing')
  })
})

// ------------------------------------------------------------------ B3
describe('B3 — listening minutes are released / settled', () => {
  it('reproduces the lockout: two full reservations exhaust the day', () => {
    const l = new BudgetLedger()
    expect(l.reserveSttMinutes(20, T0)).toEqual({ ok: true, minutes: 20 })
    expect(l.reserveSttMinutes(20, T0)).toEqual({ ok: true, minutes: 20 })
    expect(l.reserveSttMinutes(1, T0)).toMatchObject({ ok: false, reason: 'stt_daily_minutes' })
  })

  it('a failed start (0 used) refunds everything', () => {
    const l = new BudgetLedger()
    l.reserveSttMinutes(20, T0)
    expect(l.releaseSttMinutes(20, 0, dayKey(T0), T0)).toBe(20)
    expect(l.snapshot(T0).stt.minutes).toBe(0)
    expect(l.snapshot(T0).usd.today).toBe(0)
  })

  it('ending after 3 minutes keeps 3 and refunds 17 — no lockout after many short sessions', () => {
    const l = new BudgetLedger()
    for (let i = 0; i < 10; i++) {
      const r = l.reserveSttMinutes(20, T0)
      expect(r.ok).toBe(true)
      if (r.ok) l.releaseSttMinutes(r.minutes, 3, dayKey(T0), T0) // settle exactly what was granted
    }
    expect(l.snapshot(T0).stt.minutes).toBe(30)
    expect(l.reserveSttMinutes(20, T0)).toEqual({ ok: true, minutes: LIMITS.assembly.dailyFlagshipListeningMinutes - 30 })
  })

  it('refunds never go negative and are ignored after the day rolled over', () => {
    const l = new BudgetLedger()
    l.reserveSttMinutes(5, T0)
    expect(l.releaseSttMinutes(50, 0, dayKey(T0), T0)).toBe(5)
    expect(l.snapshot(T0).stt.minutes).toBe(0)
    expect(l.releaseSttMinutes(5, 0, '2000-01-01', T0)).toBe(0)
  })

  it('usedSttMinutes rounds elapsed time up and clamps to the reservation', () => {
    expect(usedSttMinutes({ startedAt: T0, sttMinutes: 20 }, T0)).toBe(0)
    expect(usedSttMinutes({ startedAt: T0, sttMinutes: 20 }, T0 + 61_000)).toBe(2)
    expect(usedSttMinutes({ startedAt: T0, sttMinutes: 20 }, T0 + 3 * 3_600_000)).toBe(20)
  })

  it('settleLocalStt refunds this instance’s ledgers exactly once', async () => {
    const st = await import('@/lib/server/state')
    const user = 'user-b3'
    const room = 'rv-bbbbbbbbbbbbbbbbbbbbbbbb'
    const now = Date.now()
    st.ledgerFor(user).reserveSttMinutes(20, now)
    st.rv().sessions.set(user, { room, conversationId: 'c', mode: 'tabletop', startedAt: now, maxMinutes: 20, generation: 0, sttMinutes: 20, sttDay: dayKey(now), sttReservationId: null })
    const before = st.ledgerFor(user).snapshot(now).stt.minutes
    expect(st.settleLocalStt(user, room, 2, now)).toBe(true)
    expect(st.ledgerFor(user).snapshot(now).stt.minutes).toBe(before - 18)
    expect(st.settleLocalStt(user, room, 2, now)).toBe(false) // idempotent
    expect(st.ledgerFor(user).snapshot(now).stt.minutes).toBe(before - 18)
  })
})

// ------------------------------------------------------------------ B4
describe('B4 — signed session ticket (stateless across serverless instances)', () => {
  const base = {
    sub: 'user-1',
    room: 'rv-aaaaaaaaaaaaaaaaaaaaaaaa',
    conversationId: 'conv1',
    generation: 0,
    mode: 'tabletop' as const,
    startedAt: T0,
    maxMinutes: 20,
    sttMinutes: 20,
    sttDay: dayKey(T0),
    sttReservationId: null,
  }

  it('a ticket signed on instance A verifies on instance B (no shared memory)', async () => {
    const t = await signSessionTicket(SECRET, base)
    const v = await verifySessionTicket(SECRET, t, { sub: 'user-1', room: base.room, now: T0 + 60_000 })
    expect(v).toMatchObject({ ok: true, expired: false, ticket: { conversationId: 'conv1', sttMinutes: 20 } })
  })

  it('rejects tampering, a different secret, other users and other rooms', async () => {
    const t = await signSessionTicket(SECRET, base)
    const [p, payload, sig] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: 'attacker' })).toString('base64url')
    expect(await verifySessionTicket(SECRET, `${p}.${forged}.${sig}`, { now: T0 })).toMatchObject({ ok: false, reason: 'bad_signature' })
    expect(await verifySessionTicket('other-secret', t, { now: T0 })).toMatchObject({ ok: false, reason: 'bad_signature' })
    expect(await verifySessionTicket(SECRET, t, { sub: 'user-2', now: T0 })).toMatchObject({ ok: false, reason: 'wrong_user' })
    expect(await verifySessionTicket(SECRET, t, { sub: 'user-1', room: 'rv-cccccccccccccccccccccccc', now: T0 })).toMatchObject({ ok: false, reason: 'wrong_room' })
    expect(await verifySessionTicket(SECRET, 'garbage', { now: T0 })).toMatchObject({ ok: false, reason: 'malformed' })
    expect(await verifySessionTicket(SECRET, null)).toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('expires after the bounded session; expired tickets may only settle (end) within a window', async () => {
    const t = await signSessionTicket(SECRET, base)
    const after = ticketExpiry(T0, 20) + 1
    expect(await verifySessionTicket(SECRET, t, { now: after })).toMatchObject({ ok: false, reason: 'expired' })
    expect(await verifySessionTicket(SECRET, t, { now: after, allowExpired: true })).toMatchObject({ ok: true, expired: true })
    expect(await verifySessionTicket(SECRET, t, { now: after + TICKET_SETTLE_WINDOW_MS + 1, allowExpired: true })).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('resolveOwnedSession authorizes from the ticket alone on a fresh instance', async () => {
    vi.resetModules()
    vi.stubEnv('REVOICE_APPROVAL_SECRET', SECRET)
    vi.stubEnv('LIVEKIT_URL', '') // no LiveKit fallback: the ticket must be sufficient
    try {
      const now = Date.now()
      const t = await signSessionTicket(SECRET, { ...base, startedAt: now, sttDay: dayKey(now) })
      const { resolveOwnedSession } = await import('@/lib/server/session')
      expect(await resolveOwnedSession('user-1', base.room, t)).toMatchObject({ via: 'ticket', conversationId: 'conv1', expired: false })
      expect(await resolveOwnedSession('user-2', base.room, t)).toBeNull()
      expect(await resolveOwnedSession('user-1', 'rv-dddddddddddddddddddddddd', t)).toBeNull()
      expect(await resolveOwnedSession('user-1', base.room, null)).toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
