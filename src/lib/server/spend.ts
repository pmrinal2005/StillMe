import 'server-only'
/**
 * A-series spend control (critical budget fixes). One place that reserves money against EVERY layer:
 *
 *   in-memory user ledger ∩ in-memory project ledger ∩ in-memory guest pool (fast pre-checks, per instance)
 *   ∩ DURABLE Supabase reservation (cross-instance source of truth: subject ∩ guest pool ∩ project ∩ reserve)
 *
 * Fixes:
 *  A1  worker speech is reserved at approval time (ref = approval id) and settled by the worker.
 *  A5  guests get a durable subject (HMAC of client IP, else device id) + a durable shared guest pool.
 *  A6  Groq requests/tokens are reserved durably (daily request count + token caps).
 *  A7  browser-direct STT reserves durably with a ref and is settled on end; every failure path releases.
 *  A8  every release path releases EVERY layer (the guest pool was forgotten before).
 *  A9  consent renewal reserves against user ∩ project ∩ durable.
 *  A3/A10 STT reservations carry ref = room, so the worker's measured usage settles them on any instance,
 *      and unsettled rows are swept lazily inside reserve_budget_v3.
 *
 * Fail closed: if the durable store is configured but unreachable or migration 0003 is missing, spend is refused.
 */
import type { Identity } from './auth'
import { adminClient } from './durable'
import { env } from './env'
import { ledgerFor, projectLedger, guestPoolLedger } from './state'
import { GUEST_LIMITS, GUEST_POOL_LIMITS, LIMITS, PRICES, type DenyReason } from '../budget'
import { hmacSha256Hex } from '../hash'

export type SpendProvider = 'assemblyai_tts' | 'assemblyai_stt' | 'groq'

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

export interface DurableSubject {
  subject: string
  user: string | null
  pool: 'guest' | null
}

/** Client IP as seen by Vercel's edge (first x-forwarded-for hop), else x-real-ip. */
export function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  return req.headers.get('x-real-ip')?.trim() || null
}

/**
 * A5: durable spending subject. Signed-in users → their uuid. Guests → HMAC(client IP) so clearing cookies
 * does NOT mint a fresh allowance (falls back to the device id only when no IP header exists), and every
 * guest also draws from the shared durable 'guest' pool.
 */
export async function durableSubject(id: Identity, req: Request): Promise<DurableSubject> {
  if (id.kind === 'supabase' && isUuid(id.userId)) return { subject: id.userId, user: id.userId, pool: null }
  if (id.kind === 'guest') {
    const ip = clientIp(req)
    const key = ip ? `ip:${ip}` : `dev:${id.userId}`
    return { subject: `guest:${(await hmacSha256Hex(env.approvalSecret(), `guest-subject:${key}`)).slice(0, 32)}`, user: null, pool: 'guest' }
  }
  return { subject: `demo:${id.userId}`.slice(0, 96), user: null, pool: null }
}

interface Caps {
  subjectUnits: number | null
  subjectUsd: number | null
  subjectCount: number | null
  poolUnits: number | null
  poolUsd: number | null
  poolCount: number | null
  projectUnits: number | null
  projectUsd: number | null
  projectCount: number | null
}

/** Durable caps for one reservation. Mirrors the in-memory LIMITS / GUEST_LIMITS / GUEST_POOL_LIMITS. */
export function durableCaps(provider: SpendProvider, guest: boolean): Caps {
  const L = guest ? GUEST_LIMITS : LIMITS
  const P = GUEST_POOL_LIMITS
  const a = LIMITS.assembly
  switch (provider) {
    case 'assemblyai_tts':
      return {
        subjectUnits: L.assembly.dailyTtsChars, subjectUsd: L.assembly.dailyUsd, subjectCount: null,
        poolUnits: guest ? P.assembly.dailyTtsChars : null, poolUsd: guest ? P.assembly.dailyUsd : null, poolCount: null,
        projectUnits: a.dailyTtsChars * 2, projectUsd: a.dailyUsd, projectCount: null,
      }
    case 'assemblyai_stt':
      return {
        subjectUnits: L.assembly.dailyFlagshipListeningMinutes, subjectUsd: L.assembly.dailyUsd, subjectCount: null,
        poolUnits: guest ? 0 : null, poolUsd: guest ? P.assembly.dailyUsd : null, poolCount: null,
        projectUnits: a.dailyFlagshipListeningMinutes * 2, projectUsd: a.dailyUsd, projectCount: null,
      }
    case 'groq':
      return {
        subjectUnits: L.groq.dailyTokens, subjectUsd: null, subjectCount: L.groq.requestsPerDay,
        poolUnits: guest ? P.groq.dailyTokens : null, poolUsd: null, poolCount: guest ? P.groq.requestsPerDay : null,
        projectUnits: LIMITS.groq.dailyTokens, projectUsd: null, projectCount: LIMITS.groq.requestsPerDay,
      }
  }
}

export function estUsd(provider: SpendProvider, units: number): number {
  if (provider === 'assemblyai_tts') return units * PRICES.ttsPerChar
  if (provider === 'assemblyai_stt') return (units / 60) * PRICES.sttFlagshipPerHour
  return 0
}

export type DurableResult = { ok: true; id: string; legacy?: boolean } | { ok: false; reason: string; unavailable?: boolean } | null

export function isMissingFunction(err: { code?: string; message?: string } | null | undefined) {
  return (
    !!err &&
    (err.code === 'PGRST202' || err.code === '42883' || err.code === '42703' || err.code === 'PGRST204' ||
      /reserve_budget_v3|settle_by_ref|progress_by_ref|record_agent_minutes|month_units|could not find the function|schema cache|column .* does not exist/i.test(err.message ?? ''))
  )
}

/**
 * Durable store schema mode, cached per instance.
 *  'v3'      migration 0003 applied (subjects, guest pool, refs, request counts, sweep, agent minutes)
 *  'legacy'  only 0001/0002 applied → reserve_budget/settle_budget (project-wide + per-user caps)
 *
 * REGRESSION FIX: the deployed site has no 0003 yet; failing closed on the missing RPC turned every
 * spend into a 503 (`budget_store_migration_required`). We now fall back to the legacy RPCs, which are
 * still durable and cross-instance for the project/lifetime caps. Re-probed every 60 s so applying
 * 0003 is picked up without a redeploy. A genuinely unreachable store still fails closed.
 */
const MODE_TTL_MS = 60_000
const modeCache = globalThis as unknown as { __rvSpendMode?: { mode: 'v3' | 'legacy'; at: number } }
export function knownStoreMode(now = Date.now()): 'v3' | 'legacy' | null {
  const m = modeCache.__rvSpendMode
  return m && now - m.at < MODE_TTL_MS ? m.mode : null
}
export function setStoreMode(mode: 'v3' | 'legacy' | null) {
  modeCache.__rvSpendMode = mode ? { mode, at: Date.now() } : undefined
}

/** Legacy (0001) reservation. Subjects/pools/refs/request counts are not durable here — the in-memory
 *  ledgers (always checked first) still enforce them per instance; the durable layer enforces the
 *  per-user (uuid only), project-daily and protected-reserve caps. */
async function reserveLegacy(s: DurableSubject, provider: SpendProvider, units: number): Promise<DurableResult> {
  const sb = adminClient()
  if (!sb) return null
  const c = durableCaps(provider, s.pool === 'guest')
  const big = 1e12
  const { data, error } = await sb.rpc('reserve_budget', {
    p_user: s.user, // null for guests/demo → only project-wide caps apply durably
    p_provider: provider,
    p_units: units,
    p_est_usd: estUsd(provider, units),
    p_user_daily_units: c.subjectUnits ?? big,
    p_project_daily_units: c.projectUnits ?? big,
    p_user_daily_usd: c.subjectUsd ?? big,
    p_project_daily_usd: c.projectUsd ?? big,
    p_lifetime_spendable_usd: LIMITS.assembly.totalCreditUsd - LIMITS.assembly.protectedReserveUsd,
  })
  if (error) return { ok: false, reason: 'budget_store_unavailable', unavailable: true } // fail closed
  const row = Array.isArray(data) ? data[0] : data
  return row?.ok ? { ok: true, id: row.reservation_id as string, legacy: true } : { ok: false, reason: (row?.reason as string) ?? 'denied' }
}

/** Durable reservation (0003, with legacy fallback). null = no durable store configured (memory ledgers apply). */
export async function reserveDurableV3(s: DurableSubject, provider: SpendProvider, units: number, ref: string | null): Promise<DurableResult> {
  const sb = adminClient()
  if (!sb) return null
  if (knownStoreMode() === 'legacy') return reserveLegacy(s, provider, units)
  const c = durableCaps(provider, s.pool === 'guest')
  const { data, error } = await sb.rpc('reserve_budget_v3', {
    p_subject: s.subject,
    p_user: s.user,
    p_pool: s.pool,
    p_provider: provider,
    p_units: units,
    p_est_usd: estUsd(provider, units),
    p_ref: ref,
    p_subject_daily_units: c.subjectUnits,
    p_subject_daily_usd: c.subjectUsd,
    p_subject_daily_count: c.subjectCount,
    p_pool_daily_units: c.poolUnits,
    p_pool_daily_usd: c.poolUsd,
    p_pool_daily_count: c.poolCount,
    p_project_daily_units: c.projectUnits,
    p_project_daily_usd: c.projectUsd,
    p_project_daily_count: c.projectCount,
    p_lifetime_spendable_usd: LIMITS.assembly.totalCreditUsd - LIMITS.assembly.protectedReserveUsd,
  })
  if (error) {
    if (isMissingFunction(error)) {
      setStoreMode('legacy')
      return reserveLegacy(s, provider, units)
    }
    return { ok: false, reason: 'budget_store_unavailable', unavailable: true } // fail closed
  }
  setStoreMode('v3')
  const row = Array.isArray(data) ? data[0] : data
  return row?.ok ? { ok: true, id: row.reservation_id as string } : { ok: false, reason: (row?.reason as string) ?? 'denied' }
}

/** Settle a durable reservation by id (idempotent: only 'reserved' rows change). */
export async function settleDurableId(id: string | null | undefined, provider: SpendProvider, commit: boolean, actualUnits?: number) {
  const sb = adminClient()
  if (!sb || !id) return
  const units = commit ? actualUnits : 0
  await sb
    .rpc('settle_budget', { p_id: id, p_commit: commit, p_actual_units: units ?? null, p_actual_usd: units === undefined ? null : estUsd(provider, units) })
    .then(() => undefined, () => undefined)
}

/**
 * Settle by reference (room for STT, `tts:<approvalId>` for worker speech).
 * `authoritative` = measured by the worker; may correct an earlier wall-clock/client settlement.
 */
export async function settleByRef(ref: string, provider: SpendProvider, commit: boolean, actualUnits: number | null, authoritative = false): Promise<number> {
  const sb = adminClient()
  if (!sb) return 0
  const { data, error } = await sb.rpc('settle_by_ref', { p_ref: ref, p_provider: provider, p_commit: commit, p_actual_units: actualUnits, p_authoritative: authoritative })
  if (error) return 0
  return Number(data ?? 0)
}

export async function progressByRef(ref: string, provider: SpendProvider, units: number) {
  const sb = adminClient()
  if (!sb) return
  await sb.rpc('progress_by_ref', { p_ref: ref, p_provider: provider, p_units: units }).then(() => undefined, () => undefined)
}

/** A2: find the caller's open STT reservation for a room WITHOUT a ticket or a live room. */
export async function durableSttByRoom(userId: string, room: string): Promise<{ id: string; units: number; createdAt: number; day: string; status: string } | null> {
  const sb = adminClient()
  if (!sb) return null
  const { data, error } = await sb
    .from('budget_reservations')
    .select('id, units, created_at, day, status')
    .eq('ref', room)
    .eq('provider', 'assemblyai_stt')
    .eq('subject', userId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !data?.length) return null
  const r = data[0] as { id: string; units: number; created_at: string; day: string; status: string }
  return { id: r.id, units: Number(r.units), createdAt: Date.parse(r.created_at), day: r.day, status: r.status }
}

/** A10: LiveKit agent minutes, recorded per room (idempotent max) and checked monthly at session start. */
export async function recordAgentMinutes(owner: string, room: string, minutes: number) {
  const sb = adminClient()
  if (!sb) return
  await sb
    .rpc('record_agent_minutes', { p_subject: owner, p_user: isUuid(owner) ? owner : null, p_ref: room, p_units: Math.max(0, Math.ceil(minutes)) })
    .then(() => undefined, () => undefined)
}

export async function agentMinutesThisMonth(): Promise<number | null> {
  const sb = adminClient()
  if (!sb) return null
  const { data, error } = await sb.rpc('month_units', { p_provider: 'livekit_agent' })
  if (error) return null
  return Number(data ?? 0)
}

// ------------------------------------------------------------------------------------------ TTS (A1, A8, A9)

export type Deny = { ok: false; status: number; body: Record<string, unknown> }
export interface TtsHandle {
  ok: true
  durableId: string | null
  /** The durable row was made by the legacy (pre-0003) RPC: it has no ref, so only id-settlement works. */
  legacy: boolean
  /** Commit memory + durable with the provider-billed characters. */
  commit(billedChars?: number): Promise<void>
  /** Commit only the in-memory ledgers (full chars); the durable row stays reserved for the worker (A1). */
  commitMemoryOnly(): void
  /** Release EVERY layer (memory user, project, guest pool, durable) — A8. */
  release(): Promise<void>
}

const denyOf = (reason: DenyReason | string, extra: Record<string, unknown> = {}, unavailable = false): Deny => ({
  ok: false,
  status: unavailable ? 503 : 429,
  body: { error: unavailable ? reason : 'budget', reason, ...extra },
})

export async function reserveTtsSpend(id: Identity, req: Request, chars: number, ref: string | null = null): Promise<TtsHandle | Deny> {
  const user = ledgerFor(id.userId).reserveTts(chars)
  if (!user.ok) return denyOf(user.reason)
  const proj = projectLedger().reserveTts(chars)
  if (!proj.ok) {
    ledgerFor(id.userId).releaseTts(user.id)
    return denyOf(proj.reason)
  }
  const pool = id.kind === 'guest' ? guestPoolLedger().reserveTts(chars) : null
  if (pool && !pool.ok) {
    ledgerFor(id.userId).releaseTts(user.id)
    projectLedger().releaseTts(proj.id)
    return denyOf('guest_pool', { message: 'Guest voice allowance is used up for today. Sign in for more.' })
  }
  const poolId = pool?.ok ? pool.id : undefined
  const releaseMemory = () => {
    ledgerFor(id.userId).releaseTts(user.id)
    projectLedger().releaseTts(proj.id)
    if (poolId) guestPoolLedger().releaseTts(poolId)
  }
  const d = await reserveDurableV3(await durableSubject(id, req), 'assemblyai_tts', chars, ref)
  if (d && !d.ok) {
    releaseMemory()
    return denyOf(d.reason, d.reason === 'guest_pool' ? { message: 'Guest voice allowance is used up for today. Sign in for more.' } : {}, d.unavailable)
  }
  const durableId = d?.ok ? d.id : null
  let done = false
  return {
    ok: true,
    durableId,
    legacy: !!(d?.ok && d.legacy),
    commitMemoryOnly() {
      if (done) return
      done = true
      ledgerFor(id.userId).commitTts(user.id)
      projectLedger().commitTts(proj.id)
      if (poolId) guestPoolLedger().commitTts(poolId)
    },
    async commit(billed) {
      if (done) return
      done = true
      ledgerFor(id.userId).commitTts(user.id, billed)
      projectLedger().commitTts(proj.id, billed)
      if (poolId) guestPoolLedger().commitTts(poolId, billed)
      await settleDurableId(durableId, 'assemblyai_tts', true, billed ?? chars)
    },
    async release() {
      if (done) return
      done = true
      releaseMemory()
      await settleDurableId(durableId, 'assemblyai_tts', false)
    },
  }
}

// ------------------------------------------------------------------------------------------ Groq (A6)

export async function reserveGroqDurable(id: Identity, req: Request, tokens: number): Promise<{ ok: true; durableId: string | null } | Deny> {
  const d = await reserveDurableV3(await durableSubject(id, req), 'groq', tokens, null)
  if (d && !d.ok) {
    const map: Record<string, string> = { user_daily_units: 'groq_daily_tokens', user_daily_requests: 'groq_rpd', project_daily_units: 'groq_daily_tokens', project_daily_requests: 'groq_rpd' }
    return denyOf(map[d.reason] ?? d.reason, d.reason === 'guest_pool' ? { message: 'Guest suggestion allowance is used up. Sign in for more.' } : {}, d.unavailable)
  }
  return { ok: true, durableId: d?.ok ? d.id : null }
}

// ------------------------------------------------------------------------------------------ STT (A3, A7, A10)

export interface SttHandle {
  ok: true
  minutes: number
  day: string
  durableId: string | null
  /** Release the in-memory ledgers (unused minutes) on this instance. */
  releaseMemory(unused: number): void
  /** Full release of every layer (setup failure). */
  releaseAll(): Promise<void>
}

export async function reserveSttSpend(id: Identity, req: Request, requested: number, ref: string, now = Date.now()): Promise<SttHandle | Deny> {
  const day = new Date(now).toISOString().slice(0, 10)
  const u = ledgerFor(id.userId).reserveSttMinutes(requested, now)
  if (!u.ok) return denyOf(u.reason)
  const p = projectLedger().reserveSttMinutes(u.minutes, now)
  if (!p.ok) {
    ledgerFor(id.userId).releaseSttMinutes(u.minutes, 0, day, now) // A7: previously leaked on /api/stt-token
    return denyOf(p.reason)
  }
  const minutes = p.minutes
  if (minutes < u.minutes) ledgerFor(id.userId).releaseSttMinutes(u.minutes - minutes, 0, day, now)
  const releaseMemory = (unused: number) => {
    ledgerFor(id.userId).releaseSttMinutes(unused, 0, day)
    projectLedger().releaseSttMinutes(unused, 0, day)
  }
  const d = await reserveDurableV3(await durableSubject(id, req), 'assemblyai_stt', minutes, ref)
  if (d && !d.ok) {
    releaseMemory(minutes)
    return denyOf(d.reason, {}, d.unavailable)
  }
  const durableId = d?.ok ? d.id : null
  return {
    ok: true,
    minutes,
    day,
    durableId,
    releaseMemory,
    async releaseAll() {
      releaseMemory(minutes)
      await settleDurableId(durableId, 'assemblyai_stt', false)
    },
  }
}

/** Status probe: is the durable spend store present and migrated? */
export async function spendStoreStatus(): Promise<'memory' | 'ready' | 'legacy' | 'unavailable'> {
  const sb = adminClient()
  if (!sb) return 'memory'
  const { error } = await sb.rpc('month_units', { p_provider: 'livekit_agent' })
  if (!error) {
    setStoreMode('v3')
    return 'ready'
  }
  if (isMissingFunction(error)) {
    setStoreMode('legacy')
    return 'legacy' // working, but apply supabase/migrations/0003_spend_control.sql for full A-series enforcement
  }
  return 'unavailable'
}
