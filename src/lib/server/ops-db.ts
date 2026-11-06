import 'server-only'
/**
 * E48 / E49 / F: thin, content-free wrappers over the 0005/0006 database objects.
 * Every wrapper is BEST-EFFORT bookkeeping unless stated otherwise: a missing function (migration not applied) or an
 * unreachable store never blocks speech or listening. The AUTHORITATIVE budget paths live in spend.ts and fail closed.
 */
import { adminClient } from './durable'
import { isMissingFunction } from './spend'
import { MAX_BIND_ATTEMPTS_PER_CODE } from '../phone'
import type { SttProfile } from '../budget'

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
const swallow = () => undefined

// ----------------------------------------------------------------------------------------- conversation sessions (E48)
export async function sessionOpen(o: { userId: string; room: string; conversationId: string; mode: string; generation: number; maxMinutes: number; sttProfile: SttProfile }): Promise<void> {
  const sb = adminClient()
  if (!sb || !isUuid(o.userId)) return
  await sb.rpc('session_open', { p_user: o.userId, p_room: o.room, p_conv: o.conversationId, p_mode: o.mode, p_generation: o.generation, p_max_minutes: o.maxMinutes, p_stt_profile: o.sttProfile }).then(swallow, swallow)
}
export async function sessionClose(room: string, reason: string): Promise<void> {
  const sb = adminClient()
  if (!sb) return
  await sb.rpc('session_close', { p_room: room, p_reason: reason }).then(swallow, swallow)
}
export async function sessionGeneration(room: string, generation: number): Promise<void> {
  const sb = adminClient()
  if (!sb) return
  await sb.rpc('session_generation', { p_room: room, p_generation: generation }).then(swallow, swallow)
}
export async function sessionMemberJoin(room: string, identity: string, role: 'partner' | 'caller'): Promise<void> {
  const sb = adminClient()
  if (!sb) return
  await sb.rpc('session_member_join', { p_room: room, p_identity: identity, p_role: role }).then(swallow, swallow)
}

// ----------------------------------------------------------------------------------------- durable pair codes (E48)
/** 'none' = no durable pair store (no Supabase / migration 0005 missing) → the LiveKit-metadata store is used. */
export type PairMode = 'durable' | 'none' | 'unavailable'

export async function pairIssueDurable(userId: string, room: string, codeHash: string, expiresAt: number): Promise<PairMode> {
  const sb = adminClient()
  if (!sb || !isUuid(userId)) return 'none'
  const { error } = await sb.rpc('phone_pair_issue', { p_user: userId, p_room: room, p_code_hash: codeHash, p_expires: new Date(expiresAt).toISOString() })
  if (!error) return 'durable'
  return isMissingFunction(error) || /phone_pair_issue/i.test(error.message ?? '') ? 'none' : 'unavailable'
}

export type PairLookupDurable = { mode: 'durable'; ok: true; room: string; owner: string; attempts: number } | { mode: 'durable'; ok: false } | { mode: 'none' } | { mode: 'unavailable' }

/** Atomic (row-locked) attempt counting: two concurrent binds cannot both read attempts=2. */
export async function pairLookupDurable(codeHash: string): Promise<PairLookupDurable> {
  const sb = adminClient()
  if (!sb) return { mode: 'none' }
  const { data, error } = await sb.rpc('phone_pair_lookup', { p_code_hash: codeHash, p_max_attempts: MAX_BIND_ATTEMPTS_PER_CODE })
  if (error) return isMissingFunction(error) || /phone_pair_lookup/i.test(error.message ?? '') ? { mode: 'none' } : { mode: 'unavailable' }
  const row = Array.isArray(data) ? data[0] : data
  if (!row?.ok) return { mode: 'durable', ok: false }
  return { mode: 'durable', ok: true, room: row.room as string, owner: row.owner as string, attempts: Number(row.attempts) }
}
export async function pairConsumeDurable(codeHash: string): Promise<void> {
  const sb = adminClient()
  if (sb) await sb.rpc('phone_pair_consume', { p_code_hash: codeHash }).then(swallow, swallow)
}
export async function pairRevokeDurable(userId: string): Promise<void> {
  const sb = adminClient()
  if (sb && isUuid(userId)) await sb.rpc('phone_pair_revoke', { p_user: userId }).then(swallow, swallow)
}
export async function pairBurnAllDurable(): Promise<void> {
  const sb = adminClient()
  if (sb) await sb.rpc('phone_pair_burn_all').then(swallow, swallow)
}

// ----------------------------------------------------------------------------------------- F: running-room budget recheck
export interface RoomBudget { ok: boolean; reason: string | null; reservationStatus: string | null; projectDayUsd: number; lifetimeUsd: number }

/**
 * Re-check a RUNNING room against the SHARED limits (project day USD, lifetime protected reserve, and the room's own
 * reservation). The room's minutes were reserved when it started; this catches everything that changed since (other
 * users spending, a reconciliation seeding the lifetime figure upward, an operator releasing the reservation).
 * null = no durable store / function missing → callers keep running on the reservation they already hold.
 */
export async function roomBudgetStatus(o: { room: string; reportedMinutes: number; projectDailyUsd: number; lifetimeSpendableUsd: number }): Promise<RoomBudget | null> {
  const sb = adminClient()
  if (!sb) return null
  const { data, error } = await sb.rpc('room_budget_status', { p_room: o.room, p_project_daily_usd: o.projectDailyUsd, p_lifetime_spendable_usd: o.lifetimeSpendableUsd, p_reported_minutes: o.reportedMinutes })
  if (error) return null
  const r = Array.isArray(data) ? data[0] : data
  if (!r) return null
  return { ok: !!r.ok, reason: (r.reason as string | null) ?? null, reservationStatus: (r.reservation_status as string | null) ?? null, projectDayUsd: Number(r.project_day_usd ?? 0), lifetimeUsd: Number(r.lifetime_usd ?? 0) }
}

// ----------------------------------------------------------------------------------------- F: estimate vs actual
export interface VarianceRow { provider: string; committedRows: number; reservedUnits: number; actualUnits: number; estUsd: number; actualUsd: number; openRows: number; releasedRows: number; unitsDelta: number; usdDelta: number }

export async function usageVariance(sinceDays = 31): Promise<VarianceRow[] | null> {
  const sb = adminClient()
  if (!sb) return null
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10)
  const { data, error } = await sb.rpc('usage_variance', { p_since: since })
  if (error || !Array.isArray(data)) return null
  return data.map((r: Record<string, unknown>) => {
    const reservedUnits = Number(r.reserved_units), actualUnits = Number(r.actual_units), estUsd = Number(r.est_usd), actualUsd = Number(r.actual_usd)
    return {
      provider: String(r.provider), committedRows: Number(r.committed_rows), reservedUnits, actualUnits, estUsd, actualUsd,
      openRows: Number(r.open_rows), releasedRows: Number(r.released_rows),
      unitsDelta: +(actualUnits - reservedUnits).toFixed(4), usdDelta: +(actualUsd - estUsd).toFixed(6),
    }
  })
}

// ----------------------------------------------------------------------------------------- E49: retention
export async function purgeAll(): Promise<{ ok: true; counts: Record<string, number> } | { ok: false; reason: string }> {
  const sb = adminClient()
  if (!sb) return { ok: false, reason: 'no_durable_store' }
  const { data, error } = await sb.rpc('purge_all_metadata')
  if (!error) return { ok: true, counts: (data ?? {}) as Record<string, number> }
  if (!isMissingFunction(error) && !/purge_all_metadata/i.test(error.message ?? '')) return { ok: false, reason: 'purge_failed' }
  // 0005 not applied: run whatever older purge functions exist (each is optional).
  const counts: Record<string, number> = {}
  for (const fn of ['purge_old_metadata', 'purge_old_phone_metadata', 'purge_old_security_metadata']) {
    const r = await sb.rpc(fn)
    if (!r.error) counts[fn] = 1
  }
  return Object.keys(counts).length ? { ok: true, counts } : { ok: false, reason: 'purge_functions_missing' }
}

// ----------------------------------------------------------------------------------------- consent history (F)
export interface ConsentHistoryRow { voiceProfileId: string; voiceId: string; action: 'initial' | 'renewal' | 'revocation'; at: number; expectedExpiry: number; providerExpiresAt: number | null; termsVersion: string }

export async function consentHistory(userId: string, limit = 50): Promise<ConsentHistoryRow[] | null> {
  const sb = adminClient()
  if (!sb || !isUuid(userId)) return null
  const { data, error } = await sb.rpc('consent_history', { p_user: userId, p_limit: limit })
  if (error || !Array.isArray(data)) return null
  return data.map((r: Record<string, unknown>) => ({
    voiceProfileId: String(r.voice_profile_id), voiceId: String(r.provider_voice_id), action: r.action as ConsentHistoryRow['action'],
    at: Date.parse(String(r.consented_at)), expectedExpiry: Date.parse(String(r.expected_expiry)),
    providerExpiresAt: r.provider_expires_at ? Date.parse(String(r.provider_expires_at)) : null, termsVersion: String(r.terms_version ?? 'v1'),
  }))
}
