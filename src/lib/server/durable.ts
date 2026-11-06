import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from './env'
import type { ReplayStore } from '../approval'
import { replayStore as memoryReplay } from './state'
import { LIMITS, PRICES } from '../budget'

/**
 * Durable adapters (Supabase service role, server-side only). When Supabase is not configured,
 * the in-process stores in state.ts are used — fine for a single `next start` instance, NOT for
 * multi-instance serverless. /api/status reports which mode is active.
 */
let admin: SupabaseClient | null | undefined
export function adminClient(): SupabaseClient | null {
  if (admin !== undefined) return admin
  const url = env.supabaseUrl()
  const key = env.supabaseService()
  admin = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null
  return admin
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

/** Replay store: Supabase `consume_approval` RPC when available (cross-instance), else memory. */
export function durableReplay(userId: string, textHash: string): ReplayStore {
  const sb = adminClient()
  if (!sb) return memoryReplay()
  return {
    async consume(approvalId: string, expiresAt: number) {
      const { data, error } = await sb.rpc('consume_approval', {
        p_approval_id: approvalId,
        p_user: null, // device ids are not auth users; replay protection needs only the approval id (works before migration 0007)
        p_text_hash: textHash,
        p_expires_at: new Date(expiresAt).toISOString(),
      })
      if (error) throw new Error('replay_store_unavailable') // fail closed: never speak if we cannot prove single use
      return data === true
    },
  }
}

export type DurableProvider = 'assemblyai_tts' | 'assemblyai_stt' | 'groq' | 'livekit_agent' | 'livekit_phone'

/**
 * Transactional reservation in Postgres (advisory-locked per provider/day). Returns
 * { ok: true, id } or { ok: false, reason }. Returns null when no durable store exists, in which
 * case callers rely on the in-memory BudgetLedger (which they always check as well).
 */
export async function reserveDurable(userId: string, provider: DurableProvider, units: number): Promise<{ ok: true; id: string } | { ok: false; reason: string } | null> {
  const sb = adminClient()
  if (!sb || !isUuid(userId)) return null
  const a = LIMITS.assembly
  const caps: Record<DurableProvider, { user: number; project: number; usd: number }> = {
    assemblyai_tts: { user: a.dailyTtsChars, project: a.dailyTtsChars * 2, usd: units * PRICES.ttsPerChar },
    assemblyai_stt: { user: a.dailyFlagshipListeningMinutes, project: a.dailyFlagshipListeningMinutes * 2, usd: (units / 60) * PRICES.sttFlagshipPerHour },
    groq: { user: LIMITS.groq.dailyTokens, project: LIMITS.groq.dailyTokens, usd: 0 },
    livekit_agent: { user: 60, project: Math.floor(LIMITS.livekit.plannedAgentMinutes / 30), usd: 0 },
    livekit_phone: { user: LIMITS.livekit.monthlyInboundPhoneMinutes, project: LIMITS.livekit.monthlyInboundPhoneMinutes, usd: 0 },
  }
  const c = caps[provider]
  const { data, error } = await sb.rpc('reserve_budget', {
    p_user: userId,
    p_provider: provider,
    p_units: units,
    p_est_usd: c.usd,
    p_user_daily_units: c.user,
    p_project_daily_units: c.project,
    p_user_daily_usd: a.dailyUsd,
    p_project_daily_usd: a.dailyUsd,
    p_lifetime_spendable_usd: a.totalCreditUsd - a.protectedReserveUsd,
  })
  if (error) return { ok: false, reason: 'budget_store_unavailable' } // fail closed
  const row = Array.isArray(data) ? data[0] : data
  return row?.ok ? { ok: true, id: row.reservation_id as string } : { ok: false, reason: (row?.reason as string) ?? 'denied' }
}

export async function settleDurable(id: string | undefined, commit: boolean, actualUnits?: number, actualUsd?: number) {
  const sb = adminClient()
  if (!sb || !id) return
  await sb.rpc('settle_budget', { p_id: id, p_commit: commit, p_actual_units: actualUnits ?? null, p_actual_usd: actualUsd ?? null }).then(
    () => undefined,
    () => undefined,
  )
}

/** Content-free usage event (provider request id, units, duration, error category). */
export async function recordUsage(e: { userId?: string; provider: string; kind: string; units?: number; estUsd?: number; requestId?: string | null; durationMs?: number; errorCategory?: string }) {
  const sb = adminClient()
  if (!sb) return
  await sb
    .from('usage_events')
    .insert({
      user_id: e.userId && isUuid(e.userId) ? e.userId : null,
      provider: e.provider,
      kind: e.kind,
      units: e.units ?? null,
      est_usd: e.estUsd ?? null,
      provider_request_id: e.requestId?.slice(0, 80) ?? null,
      duration_ms: e.durationMs ?? null,
      error_category: e.errorCategory ?? null,
    })
    .then(
      () => undefined,
      () => undefined,
    )
}

export async function audit(userId: string, evt: string, ref?: string) {
  const sb = adminClient()
  if (!sb || !isUuid(userId)) return
  await sb.from('audit_events').insert({ user_id: userId, evt, ref: ref?.slice(0, 64) ?? null }).then(
    () => undefined,
    () => undefined,
  )
}

/** Aggregate app-estimated spend for reconciliation against provider dashboards. */
export async function usageSummary(sinceDays = 31) {
  const sb = adminClient()
  if (!sb) return null
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10)
  const { data, error } = await sb.from('budget_reservations').select('provider, units, actual_units, est_usd, actual_usd, status').gte('day', since).neq('status', 'released')
  if (error || !data) return null
  const out: Record<string, { units: number; usd: number }> = {}
  for (const r of data as { provider: string; units: number; actual_units: number | null; est_usd: number; actual_usd: number | null }[]) {
    const o = (out[r.provider] ??= { units: 0, usd: 0 })
    o.units += Number(r.actual_units ?? r.units)
    o.usd += Number(r.actual_usd ?? r.est_usd)
  }
  return out
}

/** Monthly phone-call reservation (migration 0002). null = no durable store (in-memory ledger applies). */
export async function reservePhoneCallDurable(userId: string, room: string, identity: string, monthlyCap: number, perCall: number): Promise<{ ok: true; minutes: number } | { ok: false; reason: string } | null> {
  const sb = adminClient()
  if (!sb || !isUuid(userId)) return null
  const { data, error } = await sb.rpc('reserve_phone_call', { p_user: userId, p_room: room, p_identity: identity, p_monthly_cap: monthlyCap, p_per_call: perCall })
  if (error) return { ok: false, reason: 'budget_store_unavailable' } // fail closed
  const row = Array.isArray(data) ? data[0] : data
  return row?.ok ? { ok: true, minutes: Number(row.minutes) } : { ok: false, reason: (row?.reason as string) ?? 'phone_cap' }
}

export async function settlePhoneCallDurable(room: string, usedMinutes: number) {
  const sb = adminClient()
  if (!sb) return
  await sb.rpc('settle_phone_call', { p_room: room, p_used: usedMinutes }).then(
    () => undefined,
    () => undefined,
  )
}

/**
 * D #46 — durable month total of phone minutes (migration 0002 `phone_month_usage`: settled minutes, or the reservation for
 * calls that never settled). null = no durable store / the read failed (callers then fall back to the instance figure).
 */
export async function phoneMonthMinutesDurable(month: string): Promise<number | null> {
  const sb = adminClient()
  if (!sb) return null
  const { data, error } = await sb.rpc('phone_month_usage', { p_month: month })
  if (error || !data) return null
  const row = Array.isArray(data) ? data[0] : data
  const n = Number((row as { minutes?: unknown } | undefined)?.minutes)
  return Number.isFinite(n) && n >= 0 ? n : null
}
