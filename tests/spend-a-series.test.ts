/**
 * A-series (critical budget & spend control) — server logic against a FAKE Supabase RPC client.
 * The fake records every rpc call so we can assert which layer was reserved/settled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hmacSha256Hex } from '@/lib/hash'
import { SECRET } from './helpers'

type Call = { fn: string; args: Record<string, unknown> }
const calls: Call[] = []
let mode: 'v3' | 'legacy' | 'down' | 'none' = 'v3'
let deny: string | null = null
let settleByRefRows = 1

function fakeClient() {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      if (mode === 'down') return { data: null, error: { code: '08006', message: 'connection refused' } }
      const v3Only = ['reserve_budget_v3', 'settle_by_ref', 'progress_by_ref', 'record_agent_minutes', 'month_units']
      if (mode === 'legacy' && v3Only.includes(fn)) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}` } }
      if (fn === 'reserve_budget_v3' || fn === 'reserve_budget') {
        return deny ? { data: [{ ok: false, reason: deny, reservation_id: null }], error: null } : { data: [{ ok: true, reason: null, reservation_id: `res-${calls.length}` }], error: null }
      }
      if (fn === 'settle_by_ref') return { data: settleByRefRows, error: null }
      if (fn === 'month_units') return { data: 0, error: null }
      return { data: null, error: null }
    },
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }) }) }),
  }
}

let currentId: { userId: string; kind: 'supabase' | 'guest' | 'local-demo' } | null = null
vi.mock('@/lib/server/auth', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, getIdentity: async () => currentId }
})

vi.mock('@/lib/server/durable', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, adminClient: () => (mode === 'none' ? null : fakeClient()), recordUsage: async () => undefined }
})

const guest = { userId: 'guest-abc', kind: 'guest' as const }
const user = { userId: '11111111-2222-4333-8444-555555555555', kind: 'supabase' as const }
const reqFrom = (ip?: string) => new Request('http://x/api', { headers: ip ? { 'x-forwarded-for': `${ip}, 10.0.0.1` } : {} })

async function freshState() {
  const g = globalThis as Record<string, unknown>
  delete g.__rv
  delete g.__rvGuestPool
  delete g.__rvSpendMode
  vi.resetModules() // state.ts builds globalThis.__rv at module load — re-evaluate it for a clean instance
  await import('@/lib/server/state')
}

beforeEach(async () => {
  vi.stubEnv('REVOICE_APPROVAL_SECRET', SECRET)
  calls.length = 0
  mode = 'v3'
  deny = null
  settleByRefRows = 1
  currentId = null
  vi.stubEnv('LIVEKIT_URL', '')
  await freshState()
})
afterEach(() => vi.unstubAllEnvs())

describe('spend.ts legacy fallback (deployed-site 503 regression)', () => {
  it('falls back to reserve_budget when migration 0003 is missing instead of returning 503', async () => {
    mode = 'legacy'
    const { reserveTtsSpend } = await import('@/lib/server/spend')
    const r = await reserveTtsSpend(user, reqFrom(), 10)
    expect(r.ok).toBe(true)
    expect(calls.map((c) => c.fn)).toEqual(['reserve_budget_v3', 'reserve_budget'])
    if (r.ok) expect(r.legacy).toBe(true)
    // cached: the next reservation goes straight to the legacy RPC
    calls.length = 0
    await reserveTtsSpend(user, reqFrom(), 5)
    expect(calls.map((c) => c.fn)).toEqual(['reserve_budget'])
  })
  it('legacy guests are reserved project-wide (p_user null), never 503', async () => {
    mode = 'legacy'
    const { reserveTtsSpend } = await import('@/lib/server/spend')
    const r = await reserveTtsSpend(guest, reqFrom('1.2.3.4'), 2)
    expect(r.ok).toBe(true)
    expect(calls.find((c) => c.fn === 'reserve_budget')?.args.p_user).toBeNull()
  })
  it('still FAILS CLOSED when the store is unreachable', async () => {
    mode = 'down'
    const { reserveTtsSpend } = await import('@/lib/server/spend')
    const r = await reserveTtsSpend(user, reqFrom(), 10)
    expect(r).toMatchObject({ ok: false, status: 503, body: { reason: 'budget_store_unavailable' } })
  })
  it('status probe reports legacy', async () => {
    mode = 'legacy'
    const { spendStoreStatus } = await import('@/lib/server/spend')
    expect(await spendStoreStatus()).toBe('legacy')
  })
})

describe('A5 durable guest subject', () => {
  it('guest subject is derived from the client IP, so clearing cookies does not mint a new allowance', async () => {
    const { durableSubject } = await import('@/lib/server/spend')
    const a = await durableSubject({ userId: 'guest-one', kind: 'guest' }, reqFrom('9.9.9.9'))
    const b = await durableSubject({ userId: 'guest-two', kind: 'guest' }, reqFrom('9.9.9.9'))
    const c = await durableSubject({ userId: 'guest-two', kind: 'guest' }, reqFrom('8.8.8.8'))
    expect(a.subject).toBe(b.subject)
    expect(a.subject).not.toBe(c.subject)
    expect(a).toMatchObject({ user: null, pool: 'guest' })
    expect(a.subject).not.toContain('9.9.9.9') // hashed, never the raw IP
  })
  it('guest TTS reservations carry the guest pool caps', async () => {
    const { reserveTtsSpend } = await import('@/lib/server/spend')
    await reserveTtsSpend(guest, reqFrom('1.1.1.1'), 3)
    const a = calls.find((c) => c.fn === 'reserve_budget_v3')!.args
    expect(a.p_pool).toBe('guest')
    expect(a.p_pool_daily_units).toBeGreaterThan(0)
  })
})

describe('A8 speak/TTS release releases EVERY layer (incl. guest pool)', () => {
  it('release refunds user, project, guest pool and durable', async () => {
    const { reserveTtsSpend } = await import('@/lib/server/spend')
    const { guestPoolLedger, ledgerFor, projectLedger } = await import('@/lib/server/state')
    const before = guestPoolLedger().snapshot().tts.chars
    const r = await reserveTtsSpend(guest, reqFrom('2.2.2.2'), 40)
    if (!r.ok) throw new Error('reserve failed')
    await r.release()
    expect(guestPoolLedger().snapshot().tts.chars).toBe(before)
    expect(ledgerFor(guest.userId).snapshot().tts.chars).toBe(0)
    expect(projectLedger().snapshot().tts.chars).toBe(0)
    expect(calls.some((c) => c.fn === 'settle_budget' && c.args.p_commit === false)).toBe(true)
  })
  it('a durable denial releases the memory layers it had already reserved', async () => {
    deny = 'guest_pool'
    const { reserveTtsSpend } = await import('@/lib/server/spend')
    const { guestPoolLedger, projectLedger } = await import('@/lib/server/state')
    const r = await reserveTtsSpend(guest, reqFrom('3.3.3.3'), 40)
    expect(r).toMatchObject({ ok: false, status: 429, body: { reason: 'guest_pool' } })
    expect(guestPoolLedger().snapshot().tts.chars).toBe(0)
    expect(projectLedger().snapshot().tts.chars).toBe(0)
  })
})

describe('A6 Groq durable reservation', () => {
  it('reserves request count + tokens durably and maps denials', async () => {
    const { reserveGroqDurable } = await import('@/lib/server/spend')
    const ok = await reserveGroqDurable(user, reqFrom(), 680)
    expect(ok.ok).toBe(true)
    const a = calls.find((c) => c.fn === 'reserve_budget_v3')!.args
    expect(a).toMatchObject({ p_provider: 'groq', p_units: 680, p_subject_daily_count: expect.any(Number), p_project_daily_count: expect.any(Number) })
    deny = 'user_daily_requests'
    expect(await reserveGroqDurable(user, reqFrom(), 680)).toMatchObject({ ok: false, status: 429, body: { reason: 'groq_rpd' } })
  })
})

describe('A7 STT reservation: refs + every failure path releases', () => {
  it('reserves with ref and releaseAll refunds memory + durable', async () => {
    const { reserveSttSpend } = await import('@/lib/server/spend')
    const { ledgerFor, projectLedger } = await import('@/lib/server/state')
    const r = await reserveSttSpend(user, reqFrom(), 10, 'sd-0123456789abcdef01234567'.slice(0, 27))
    if (!r.ok) throw new Error('reserve failed')
    expect(calls.find((c) => c.fn === 'reserve_budget_v3')!.args.p_ref).toMatch(/^sd-/)
    expect(ledgerFor(user.userId).snapshot().stt.minutes).toBe(10)
    await r.releaseAll()
    expect(ledgerFor(user.userId).snapshot().stt.minutes).toBe(0)
    expect(projectLedger().snapshot().stt.minutes).toBe(0)
  })
  it('a durable denial does not leak the user ledger minutes', async () => {
    deny = 'project_daily_units'
    const { reserveSttSpend } = await import('@/lib/server/spend')
    const { ledgerFor } = await import('@/lib/server/state')
    const r = await reserveSttSpend(user, reqFrom(), 10, 'rv-0123456789abcdef01234567')
    expect(r.ok).toBe(false)
    expect(ledgerFor(user.userId).snapshot().stt.minutes).toBe(0)
  })
})

describe('A10 minutes to commit', () => {
  it('worker-measured connected minutes win over wall clock, clamped to the reservation', async () => {
    const { sttMinutesToCommit } = await import('@/lib/spend-refs')
    expect(sttMinutesToCommit({ reserved: 20, startedAt: 0, now: 15 * 60_000, measuredMinutes: 2.2 })).toBe(3)
    expect(sttMinutesToCommit({ reserved: 20, startedAt: 0, now: 15 * 60_000 })).toBe(15)
    expect(sttMinutesToCommit({ reserved: 5, startedAt: 0, now: 15 * 60_000 })).toBe(5)
    expect(sttMinutesToCommit({ reserved: 5, startedAt: 0, now: 0, measuredMinutes: 0 })).toBe(0)
  })
})

async function workerReq(body: unknown) {
  const raw = JSON.stringify(body)
  const ts = Date.now()
  const sig = await hmacSha256Hex(SECRET, `worker:${ts}:${raw}`)
  return new Request('http://x/api/worker/usage', { method: 'POST', body: raw, headers: { 'x-revoice-worker': `${ts}.${sig}`, 'content-type': 'application/json' } })
}

describe('A1/A10 /api/worker/usage', () => {
  it('rejects unsigned requests', async () => {
    const { POST } = await import('@/app/api/worker/usage/route')
    const res = await POST(new Request('http://x', { method: 'POST', body: '{"kind":"tts","approvalId":"aaaaaaaaaaaaaaaa","chars":3}' }))
    expect(res.status).toBe(401)
  })
  it('tts chars>0 commits by ref tts:<approvalId> (authoritative); 0 releases', async () => {
    const { POST } = await import('@/app/api/worker/usage/route')
    const id = 'a'.repeat(32)
    expect((await POST(await workerReq({ kind: 'tts', approvalId: id, chars: 12 }))).status).toBe(200)
    expect(calls.at(-1)).toMatchObject({ fn: 'settle_by_ref', args: { p_ref: `tts:${id}`, p_provider: 'assemblyai_tts', p_commit: true, p_actual_units: 12, p_authoritative: true } })
    await POST(await workerReq({ kind: 'tts', approvalId: 'b'.repeat(32), chars: 0 }))
    expect(calls.at(-1)).toMatchObject({ fn: 'settle_by_ref', args: { p_ref: `tts:${'b'.repeat(32)}`, p_commit: false } })
  })
  it('stt heartbeat records progress; final commits connected minutes authoritatively', async () => {
    const { POST } = await import('@/app/api/worker/usage/route')
    const room = 'rv-0123456789abcdef01234567'
    await POST(await workerReq({ kind: 'stt', room, minutes: 1.5, final: false }))
    expect(calls.at(-1)).toMatchObject({ fn: 'progress_by_ref', args: { p_ref: room, p_units: 1.5 } })
    await POST(await workerReq({ kind: 'stt', room, minutes: 2.1, final: true }))
    expect(calls.at(-1)).toMatchObject({ fn: 'settle_by_ref', args: { p_ref: room, p_actual_units: 3, p_authoritative: true } })
  })
  it('agent minutes are recorded per room', async () => {
    const { POST } = await import('@/app/api/worker/usage/route')
    await POST(await workerReq({ kind: 'agent', room: 'rv-0123456789abcdef01234567', owner: user.userId, minutes: 4.2 }))
    expect(calls.at(-1)).toMatchObject({ fn: 'record_agent_minutes', args: { p_ref: 'rv-0123456789abcdef01234567', p_units: 5, p_user: user.userId } })
  })
})

describe('A2/A3 /api/livekit/end: ticket-only auth + settlement by ref', () => {
  const room = 'sd-0123456789abcdef01234567'.slice(0, 27)
  const endReq = (body: unknown) => new Request('http://x/api/livekit/end', { method: 'POST', body: JSON.stringify(body) })
  async function ticketFor(sub: string, r: string, over: Record<string, unknown> = {}) {
    const { signSessionTicket } = await import('@/lib/session-ticket')
    return signSessionTicket(SECRET, { sub, room: r, conversationId: r, generation: 0, mode: 'tabletop', startedAt: Date.now() - 90_000, maxMinutes: 10, sttMinutes: 10, sttDay: '2026-11-04', sttReservationId: null, ...over })
  }

  it('a valid ticket ALONE settles by ref (no LiveKit, no instance memory) — 2 elapsed minutes committed', async () => {
    currentId = user
    const { POST } = await import('@/app/api/livekit/end/route')
    const res = await POST(endReq({ room, reason: 'user', ticket: await ticketFor(user.userId, room) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, minutesUsed: 2 })
    expect(calls.find((c) => c.fn === 'settle_by_ref')).toMatchObject({ args: { p_ref: room, p_provider: 'assemblyai_stt', p_commit: true, p_actual_units: 2, p_authoritative: false } })
  })
  it('a ticket carrying a reservation id settles that id', async () => {
    currentId = user
    const { POST } = await import('@/app/api/livekit/end/route')
    await POST(endReq({ room, ticket: await ticketFor(user.userId, room, { sttReservationId: 'res-xyz' }) }))
    expect(calls.find((c) => c.fn === 'settle_budget')).toMatchObject({ args: { p_id: 'res-xyz', p_commit: true, p_actual_units: 2 } })
  })
  it("someone else's ticket is refused (403) and nothing is settled", async () => {
    currentId = { userId: 'intruder', kind: 'supabase' }
    const { POST } = await import('@/app/api/livekit/end/route')
    const res = await POST(endReq({ room, ticket: await ticketFor(user.userId, room) }))
    expect(res.status).toBe(403)
    expect(calls.some((c) => c.fn.startsWith('settle'))).toBe(false)
  })
  it('rejects malformed room ids', async () => {
    currentId = user
    const { POST } = await import('@/app/api/livekit/end/route')
    expect((await POST(endReq({ room: 'nope' }))).status).toBe(400)
  })
})
