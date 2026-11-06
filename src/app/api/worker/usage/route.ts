import { z } from 'zod'
import { json } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { verifyWorkerAuth } from '@/lib/server/worker-auth'
import { progressByRef, recordAgentMinutes, settleByRef } from '@/lib/server/spend'
import { recordUsage } from '@/lib/server/durable'
import { logEvent } from '@/lib/server/log'
import { withJsonErrors } from '@/lib/server/route'
import { ROOM_RE, workerTtsRef } from '@/lib/spend-refs'
import { LIMITS, PRICES, PROJECT_LIMITS, sttRatePerHour } from '@/lib/budget'
import { roomBudgetStatus } from '@/lib/server/ops-db'

export const dynamic = 'force-dynamic'

/**
 * Worker-only (HMAC, same scheme as /api/phone/usage). Content-free usage reports that settle durable
 * reservations BY REFERENCE, so it does not matter which serverless instance made them.
 *
 *  tts    A1: characters the worker actually synthesized for approval `approvalId`
 *              (0 = rejected/failed before any audio → released; otherwise committed, clamped to the reservation).
 *  stt    A10: minutes the AssemblyAI streaming socket was actually CONNECTED for `room`.
 *              final=false → heartbeat (used by the sweep if the final report never arrives);
 *              final=true  → authoritative commit (may correct a wall-clock settlement made by /api/livekit/end).
 *  agent  A10: LiveKit agent minutes for `room` (idempotent max), counted against the monthly agent cap.
 */
const Body = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tts'), approvalId: z.string().regex(/^[a-f0-9]{16,64}$/), chars: z.number().int().min(0).max(5000) }),
  z.object({ kind: z.literal('stt'), room: z.string().regex(ROOM_RE), minutes: z.number().min(0).max(24 * 60), final: z.boolean(), profile: z.enum(['flagship', 'economy']).optional() }),
  z.object({ kind: z.literal('agent'), room: z.string().regex(ROOM_RE), owner: z.string().min(1).max(96), minutes: z.number().min(0).max(24 * 60) }),
])

async function handlePOST(req: Request) {
  const raw = await req.text()
  if (!(await verifyWorkerAuth(env.approvalSecret(), req.headers.get('x-revoice-worker'), raw))) return json({ error: 'unauthorized' }, 401)
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: 'invalid_request' }, 400)
  }
  const parsed = Body.safeParse(body)
  if (!parsed.success) return json({ error: 'invalid_request' }, 400)
  const b = parsed.data

  if (b.kind === 'tts') {
    const n = b.chars > 0
      ? await settleByRef(workerTtsRef(b.approvalId), 'assemblyai_tts', true, b.chars, true)
      : await settleByRef(workerTtsRef(b.approvalId), 'assemblyai_tts', false, null)
    void recordUsage({ provider: 'assemblyai', kind: 'tts_worker', units: b.chars, estUsd: b.chars * PRICES.ttsPerChar })
    logEvent({ evt: 'worker_usage', kind: 'tts', chars: b.chars, settled: n })
    return json({ ok: true, settled: n })
  }
  if (b.kind === 'stt') {
    if (!b.final) {
      await progressByRef(b.room, 'assemblyai_stt', b.minutes)
      // F: re-check the RUNNING room against the shared limits on every heartbeat. The room's own minutes were reserved at
      // start, but project spend, the lifetime protected reserve and the room's reservation itself can change underneath it.
      // `stop: true` tells the worker to end the session (reason budget) instead of billing past a limit.
      const rb = await roomBudgetStatus({
        room: b.room,
        reportedMinutes: b.minutes,
        projectDailyUsd: PROJECT_LIMITS.assembly.dailyUsd,
        lifetimeSpendableUsd: LIMITS.assembly.totalCreditUsd - LIMITS.assembly.protectedReserveUsd,
      })
      if (rb && !rb.ok) {
        logEvent({ evt: 'worker_usage', kind: 'stt', room: b.room, status: 'budget_stop', reason: rb.reason ?? 'denied' })
        return json({ ok: true, settled: 0, stop: true, reason: rb.reason })
      }
      return json({ ok: true, settled: 0, stop: false })
    }
    const n = await settleByRef(b.room, 'assemblyai_stt', true, Math.ceil(b.minutes - 1e-9), true)
    void recordUsage({ provider: 'assemblyai', kind: 'stt_worker', units: b.minutes, estUsd: (b.minutes / 60) * sttRatePerHour(b.profile) })
    logEvent({ evt: 'worker_usage', kind: 'stt', room: b.room, minutes: Math.round(b.minutes * 100) / 100, settled: n })
    return json({ ok: true, settled: n })
  }
  await recordAgentMinutes(b.owner, b.room, b.minutes)
  logEvent({ evt: 'worker_usage', kind: 'agent', room: b.room, minutes: Math.round(b.minutes * 100) / 100 })
  return json({ ok: true })
}

export const POST = withJsonErrors('worker/usage', handlePOST)
