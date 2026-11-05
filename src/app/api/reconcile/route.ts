import { z } from 'zod'
import { getIdentity, isOperator, json, requireAccount, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { monthKey, phoneMonthUsed, projectLedger, rv } from '@/lib/server/state'
import { adminClient, audit, usageSummary } from '@/lib/server/durable'
import { LIMITS } from '@/lib/budget'
import { TELEPHONY } from '@/lib/features'
import { clampReconcileSeed, reconcile } from '@/lib/reconcile'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

/**
 * Provider-usage reconciliation. The app ledger is an ESTIMATE and not a provider-enforced cap.
 *  GET  → app-estimated usage (durable store if configured, else this process) + recorded provider figures + drift.
 *  POST → operator records figures read from the AssemblyAI / Groq / LiveKit dashboards (content-free).
 */
// B13: operator access is `isOperator()` from auth.ts — FAIL CLOSED. With REVOICE_OPERATOR_IDS and
// REVOICE_OPERATOR_EMAILS both empty NOBODY is an operator (the old local copy returned `true` for everyone, so any
// signed-in or anonymous account could read project spend and post provider figures). Anonymous Supabase users are
// guests and never operators; e-mail operators need a CONFIRMED address.

const Body = z.object({
  provider: z.enum(['assemblyai', 'groq', 'livekit', 'supabase', 'vercel']),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  providerReportedUsd: z.number().min(0).max(100_000).nullable(),
  providerReportedUnits: z.record(z.string().max(40), z.number().min(0)).default({}),
  note: z.string().max(300).default(''),
})

async function appEstimate() {
  const durable = await usageSummary(31)
  const snap = projectLedger().snapshot()
  const assemblyUsd = durable
    ? (durable.assemblyai_tts?.usd ?? 0) + (durable.assemblyai_stt?.usd ?? 0)
    : snap.usd.lifetime
  return {
    source: durable ? 'supabase' : 'process-memory',
    assemblyaiUsd: +assemblyUsd.toFixed(4),
    byProvider: durable ?? { today: snap },
    phone: { month: monthKey(), minutesUsed: phoneMonthUsed(), cap: TELEPHONY.monthlyInboundMinutesCap, included: 50 },
    limits: { protectedReserveUsd: LIMITS.assembly.protectedReserveUsd, totalCreditUsd: LIMITS.assembly.totalCreditUsd },
  }
}

async function handleGET(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  { const gate = requireAccount(id, 'reconciliation'); if (gate) return gate }
  if (!isOperator(id)) return json({ error: 'forbidden' }, 403)
  const estimate = await appEstimate()
  let recorded: { provider: string; periodStart: string; periodEnd: string; providerReportedUsd: number | null; note: string; at: number }[] = rv().reconciliations.map((r) => ({ ...r }))
  const sb = adminClient()
  if (sb) {
    const { data } = await sb.from('provider_reconciliations').select('provider, period_start, period_end, provider_reported_usd, note, created_at').order('created_at', { ascending: false }).limit(20)
    if (data) recorded = data.map((r) => ({ provider: r.provider, periodStart: r.period_start, periodEnd: r.period_end, providerReportedUsd: r.provider_reported_usd, note: r.note ?? '', at: Date.parse(r.created_at) }))
  }
  const latestAai = recorded.find((r) => r.provider === 'assemblyai')
  return json({ estimate, recorded, assemblyai: latestAai ? reconcile(estimate.assemblyaiUsd, latestAai.providerReportedUsd) : null })
}

async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  { const gate = requireAccount(id, 'reconciliation'); if (gate) return gate }
  if (!isOperator(id)) return json({ error: 'forbidden' }, 403)
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request', issues: parsed.error.issues.slice(0, 5) }, 400)
  const b = parsed.data
  if (b.periodEnd < b.periodStart) return json({ error: 'invalid_period' }, 400)
  const estimate = await appEstimate()
  const appUsd = b.provider === 'assemblyai' ? estimate.assemblyaiUsd : null
  const sb = adminClient()
  if (sb) {
    const { error } = await sb.from('provider_reconciliations').insert({
      provider: b.provider,
      period_start: b.periodStart,
      period_end: b.periodEnd,
      provider_reported_usd: b.providerReportedUsd,
      provider_reported_units: b.providerReportedUnits,
      app_estimated_usd: appUsd,
      note: b.note || null,
      recorded_by: /^[0-9a-f-]{36}$/i.test(id.userId) ? id.userId : null,
    })
    if (error) return json({ error: 'store_unavailable' }, 503)
  }
  const list = rv().reconciliations
  list.unshift({ at: Date.now(), provider: b.provider, periodStart: b.periodStart, periodEnd: b.periodEnd, providerReportedUsd: b.providerReportedUsd, note: b.note })
  list.splice(50)
  void audit(id.userId, 'reconciliation', b.provider)
  // If the provider reports MORE than the app estimated, the ledger is seeded upward so caps stay conservative.
  // B13: the seed is CLAMPED to [0, total credit]. An unbounded figure (the schema allows 100 000) used to push
  // lifetimeUsd past the spendable limit and lock every user out of speech until the next cold start — one typo or one
  // hostile operator request was a denial of service.
  if (b.provider === 'assemblyai' && b.providerReportedUsd !== null) {
    const seeded = clampReconcileSeed(b.providerReportedUsd)
    if (seeded > projectLedger().lifetimeUsd) projectLedger().lifetimeUsd = seeded
  }
  return json({ ok: true, result: appUsd === null ? null : reconcile(appUsd, b.providerReportedUsd) })
}

export const GET = withJsonErrors('reconcile', handleGET)
export const POST = withJsonErrors('reconcile', handlePOST)
