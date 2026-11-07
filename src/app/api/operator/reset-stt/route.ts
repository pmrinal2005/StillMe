import { getIdentity, isOperator, json } from '@/lib/server/auth'
import { adminClient } from '@/lib/server/durable'
import { resetSttLedgers } from '@/lib/server/state'
import { logEvent } from '@/lib/server/log'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

/**
 * Operator-only quota reset for the "Could not start listening (stt daily minutes)" lockout.
 *
 * - Clears every in-memory listening-minute reservation on THIS instance (device, network pool, project).
 * - With a durable Supabase store, releases STT reservations that are still `reserved` (a session that never settled) for today.
 *
 * Auth = REVOICE_OPERATOR_TOKEN in the `x-revoice-operator` header (no accounts exist). FAIL CLOSED when unset.
 * Content-free: only counts are returned. On serverless hosting every warm instance has its own memory, so also redeploy
 * (or wait for a cold start) to clear all of them; the durable release below is global.
 */
async function handlePOST(req: Request) {
  await getIdentity(req)
  if (!(await isOperator(req))) return json({ error: 'forbidden', message: 'Operator token required.' }, 403)
  const mem = resetSttLedgers()
  let durableReleased: number | null = null
  const sb = adminClient()
  if (sb) {
    const day = new Date().toISOString().slice(0, 10)
    const { data, error } = await sb
      .from('budget_reservations')
      .update({ status: 'released', actual_units: 0, actual_usd: 0 })
      .eq('provider', 'assemblyai_stt')
      .eq('status', 'reserved')
      .eq('day', day)
      .select('id')
    durableReleased = error ? null : (data?.length ?? 0)
  }
  logEvent({ evt: 'stt_quota_reset', cleared: mem.cleared, durable: durableReleased ?? -1 })
  return json({ ok: true, memoryMinutesCleared: mem.cleared, durableReservationsReleased: durableReleased })
}

export const POST = withJsonErrors('operator/reset-stt', handlePOST)
