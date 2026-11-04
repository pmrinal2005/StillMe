import { z } from 'zod'
import { getIdentity, json, requireAccount, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { activeSession, ledgerFor, projectLedger, rv, settleLocalStt } from '@/lib/server/state'
import { createRoomAndDispatch, deleteRoom, listOwnerRooms, newRoomName, ownerToken, signInvite } from '@/lib/server/livekit'
import { reserveDurable, settleDurable } from '@/lib/server/durable'
import { resolveOwnedSession, ticketFrom } from '@/lib/server/session'
import { logEvent } from '@/lib/server/log'
import { InputLanguage, OutputLanguage } from '@/lib/contracts'
import { randomId } from '@/lib/hash'
import { dayKey, LIMITS } from '@/lib/budget'
import { signSessionTicket, usedSttMinutes } from '@/lib/session-ticket'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

const Body = z.object({
  mode: z.enum(['tabletop', 'partner-link', 'remote']),
  voiceId: z.string().min(1).max(128),
  outputLanguage: OutputLanguage,
  inputLanguages: z.array(InputLanguage).max(4).default([]),
  keyterms: z.array(z.string().min(1).max(50)).max(30).default([]),
  contextPrompt: z.string().max(300).default(''),
  minutes: z.number().int().min(1).max(LIMITS.assembly.interactiveSessionMinutes).default(LIMITS.assembly.interactiveSessionMinutes),
  /** Replace an existing active conversation (ends it first). */
  replace: z.boolean().default(false),
  /** Ticket of the session being replaced (lets any instance settle its reservation — B3/B4). */
  ticket: z.string().max(2000).optional(),
})

/** End an existing room of this user and settle its STT reservation (used by `replace`). */
async function closeExisting(userId: string, room: string, ticket: string | null) {
  const s = await resolveOwnedSession(userId, room, ticket, { allowExpired: true }).catch(() => null)
  await deleteRoom(room)
  const used = s ? usedSttMinutes(s) : 0
  settleLocalStt(userId, room, used)
  if (s?.sttReservationId) await settleDurable(s.sttReservationId, true, used)
  logEvent({ evt: 'session_end', room, reason: 'replaced', minutes: used })
}

/** Start an explicit, bounded listening session (ONE active conversation per user). */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  { const gate = requireAccount(id, 'listening sessions'); if (gate) return gate }
  if (!env.livekitUrl() || !env.livekitKey() || !env.livekitSecret()) return json({ error: 'livekit_not_configured' }, 503)
  const raw = await req.json().catch(() => null)
  const parsed = Body.safeParse(raw)
  if (!parsed.success) return json({ error: 'invalid_request' }, 400)
  const b = parsed.data
  const priorTicket = ticketFrom(req, b)

  // ---- one active conversation per user — checked against LiveKit (B4), not just this instance's memory
  try {
    const existing = new Set<string>()
    const cached = activeSession(id.userId)
    if (cached) existing.add(cached.room)
    for (const r of await listOwnerRooms(id.userId)) existing.add(r.room)
    if (existing.size) {
      if (!b.replace) return json({ error: 'session_active', room: [...existing][0] }, 409)
      for (const room of existing) await closeExisting(id.userId, room, priorTicket)
    }
  } catch (e) {
    logEvent({ evt: 'session_start', status: 'error', reason: 'livekit_unreachable', detail: (e as Error).message?.slice(0, 120) })
    return json({ error: 'livekit_unreachable', message: 'Could not reach LiveKit. Typing and phrases still work.' }, 502)
  }

  // ---- reserve listening minutes (user ∩ project ∩ durable). Every failure path below RELEASES them (B3).
  const now = Date.now()
  const sttDay = dayKey(now)
  const u = ledgerFor(id.userId).reserveSttMinutes(b.minutes, now)
  if (!u.ok) return json({ error: 'budget', reason: u.reason }, 429)
  const p = projectLedger().reserveSttMinutes(u.minutes, now)
  if (!p.ok) {
    ledgerFor(id.userId).releaseSttMinutes(u.minutes, 0, sttDay) // B3: previously leaked
    return json({ error: 'budget', reason: p.reason }, 429)
  }
  const minutes = p.minutes
  if (minutes < u.minutes) ledgerFor(id.userId).releaseSttMinutes(u.minutes - minutes, 0, sttDay) // trim to the intersecting grant
  const releaseLocal = () => {
    ledgerFor(id.userId).releaseSttMinutes(minutes, 0, sttDay)
    projectLedger().releaseSttMinutes(minutes, 0, sttDay)
  }
  const d = await reserveDurable(id.userId, 'assemblyai_stt', minutes)
  if (d && !d.ok) {
    releaseLocal() // B3: previously leaked
    return json({ error: 'budget', reason: d.reason }, 429)
  }
  const sttReservationId = d?.ok ? d.id : null

  const room = newRoomName()
  const conversationId = randomId(10)
  let roomCreated = false
  try {
    const token = await ownerToken({ identity: id.userId, room, mode: b.mode }) // mint BEFORE creating the room (B1 failed here after dispatch)
    const invite = b.mode === 'tabletop' ? null : await signInvite(room, id.userId)
    roomCreated = true
    await createRoomAndDispatch(room, {
      ownerIdentity: id.userId,
      conversationId,
      generation: 0,
      mode: b.mode,
      voiceId: b.voiceId,
      outputLanguage: b.outputLanguage,
      inputLanguages: b.inputLanguages,
      keyterms: b.keyterms,
      contextPrompt: b.contextPrompt,
      maxSessionMinutes: minutes,
      startedAt: now,
      sttMinutes: minutes,
      sttReservationId,
    })
    rv().sessions.set(id.userId, { room, conversationId, mode: b.mode, startedAt: now, maxMinutes: minutes, generation: 0, sttMinutes: minutes, sttDay, sttReservationId })
    const ticket = await signSessionTicket(env.approvalSecret(), {
      sub: id.userId,
      room,
      conversationId,
      generation: 0,
      mode: b.mode,
      startedAt: now,
      maxMinutes: minutes,
      sttMinutes: minutes,
      sttDay,
      sttReservationId,
    })
    logEvent({ evt: 'session_start', room, kind: b.mode, minutes })
    return json({ url: env.livekitUrl(), token, room, conversationId, invite, ticket, maxSessionMinutes: minutes, generation: 0 })
  } catch (e) {
    // B3/B7: never leak the room or the reservation; return a JSON error instead of an empty 500.
    if (roomCreated) await deleteRoom(room)
    rv().sessions.delete(id.userId)
    releaseLocal()
    if (sttReservationId) await settleDurable(sttReservationId, false)
    logEvent({ evt: 'session_start', status: 'error', room, reason: 'setup_failed', detail: (e as Error).message?.slice(0, 120) })
    return json({ error: 'session_start_failed', message: 'Could not start the listening room. No listening minutes were used.' }, 502)
  }
}

export const POST = withJsonErrors('livekit/session', handlePOST)
