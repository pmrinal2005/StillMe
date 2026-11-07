import { z } from 'zod'
import { getIdentity, json } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { reserveSttSpend } from '@/lib/server/spend'
import { signSessionTicket } from '@/lib/session-ticket'
import { DIRECT_STT_PREFIX } from '@/lib/spend-refs'
import { randomId } from '@/lib/hash'
import { logEvent } from '@/lib/server/log'
import { mintSttToken, sttWsUrl } from '@/lib/server/assemblyai'
import { InputLanguage } from '@/lib/contracts'
import { LIMITS } from '@/lib/budget'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

const Body = z.object({
  sampleRate: z.number().int().min(8000).max(48000),
  languageCodes: z.array(InputLanguage).max(4).default([]),
  keyterms: z.array(z.string().min(1).max(50)).max(30).default([]),
  minutes: z.number().int().min(1).max(LIMITS.assembly.interactiveSessionMinutes).default(10),
})

/**
 * Browser-direct STT (guest-launchable; ON by default, disable with REVOICE_ALLOW_BROWSER_STT=false).
 * Each mint reserves bounded listening minutes durably (A7); the token's max session duration enforces the cap,
 * and the client settles the reservation through /api/livekit/end with the returned ticket.
 */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!env.allowBrowserStt()) return json({ error: 'browser_stt_disabled' }, 403)
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request' }, 400)
  const b = parsed.data

  // A7: durable reservation (user ∩ project ∩ durable) with ref = a pseudo-session id, so /api/livekit/end can
  // settle it on ANY instance. Previously only per-instance memory was charged, the user reservation leaked when
  // the project cap refused, and nothing was ever settled. Every failure path below releases every layer.
  const now = Date.now()
  const session = `${DIRECT_STT_PREFIX}${randomId(12)}`
  const spend = await reserveSttSpend(id, req, b.minutes, session, now)
  if (!spend.ok) return json(spend.body, spend.status)
  let token: string
  try {
    token = await mintSttToken(spend.minutes * 60) // the token's max session duration enforces the reservation
  } catch (e) {
    await spend.releaseAll()
    logEvent({ evt: 'stt_token', status: 'error', detail: (e as Error).message?.slice(0, 80) })
    return json({ error: 'stt_token_failed', message: 'Could not start listening. No listening minutes were used.' }, 502)
  }
  // Signed ticket for the pseudo-session: the client presents it to /api/livekit/end to settle (elapsed minutes
  // committed, the rest refunded). If it never does, the durable sweep commits the reservation in full.
  const ticket = await signSessionTicket(env.approvalSecret(), {
    sub: id.userId,
    room: session,
    conversationId: session,
    generation: 0,
    mode: 'tabletop',
    startedAt: now,
    maxMinutes: spend.minutes,
    sttMinutes: spend.minutes,
    sttDay: spend.day,
    sttReservationId: spend.durableId,
  })
  logEvent({ evt: 'stt_token', session, minutes: spend.minutes })
  return json({
    wsUrl: sttWsUrl({ token, sampleRate: b.sampleRate, languageCodes: b.languageCodes, keyterms: b.keyterms }),
    maxSessionSeconds: spend.minutes * 60,
    session,
    ticket,
  })
}

export const POST = withJsonErrors('stt-token', handlePOST)
