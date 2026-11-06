import { z } from 'zod'
import { getIdentity, json, requireAccount, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { activeSession, rv, settleLocalStt } from '@/lib/server/state'
import { createRoomAndDispatch, deleteRoom, listOwnerRooms, newRoomName, ownerParticipantIdentity, ownerToken, signInvite } from '@/lib/server/livekit'
import { authorizeVoice, VoiceRegistryError, voiceStoreFor } from '@/lib/server/voice-registry'
import { agentMinutesThisMonth, reserveSttSpend, settleByRef, settleDurableId } from '@/lib/server/spend'
import { resolveOwnedSession, ticketFrom } from '@/lib/server/session'
import { logEvent } from '@/lib/server/log'
import { InputLanguage, OutputLanguage } from '@/lib/contracts'
import { randomId } from '@/lib/hash'
import { LIMITS } from '@/lib/budget'
import { signSessionTicket, usedSttMinutes, verifySessionTicket } from '@/lib/session-ticket'
import { planExistingSessions } from '@/lib/session-replace'
import { withJsonErrors } from '@/lib/server/route'
import { sessionClose, sessionOpen } from '@/lib/server/ops-db'

export const dynamic = 'force-dynamic'

const Body = z.object({
  mode: z.enum(['tabletop', 'partner-link', 'remote']),
  voiceId: z.string().min(1).max(128),
  outputLanguage: OutputLanguage,
  inputLanguages: z.array(InputLanguage).max(4).default([]),
  keyterms: z.array(z.string().min(1).max(50)).max(30).default([]),
  contextPrompt: z.string().max(300).default(''),
  minutes: z.number().int().min(1).max(LIMITS.assembly.interactiveSessionMinutes).default(LIMITS.assembly.interactiveSessionMinutes),
  /**
   * D #35: explicit consent to END a conversation this device does not hold (e.g. one running on another device).
   * A stale session whose ticket this device presents is replaced without it.
   */
  replace: z.boolean().default(false),
  /** F: `economy` = Universal-Streaming ($0.15/h, English + 5 European languages); `flagship` = Universal-3.6 Pro ($0.45/h, 32 languages). */
  sttProfile: z.enum(['flagship', 'economy']).default('flagship'),
  /** Ticket of the session being replaced (lets any instance settle its reservation — B3/B4). */
  ticket: z.string().max(2000).optional(),
})

/** End an existing room of this user and settle its STT reservation (used by `replace`). */
async function closeExisting(userId: string, room: string, ticket: string | null) {
  const s = await resolveOwnedSession(userId, room, ticket, { allowExpired: true }).catch(() => null)
  await deleteRoom(room)
  const used = s ? usedSttMinutes(s) : 0
  settleLocalStt(userId, room, used)
  if (s?.sttReservationId) await settleDurableId(s.sttReservationId, 'assemblyai_stt', true, used)
  else await settleByRef(room, 'assemblyai_stt', true, used, false) // A3: no id (legacy ticket / LiveKit-only) → by ref
  void sessionClose(room, 'replaced')
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

  // ---- B11/B12: the voice must be authorized for THIS account before a room/worker/reservation exists.
  // (Library voices are open; a cloned voice needs its server-side registration with complete, unexpired, unrevoked consent.)
  try {
    const va = await authorizeVoice(voiceStoreFor(id.userId), id, b.voiceId, env.assemblyRegion())
    if (!va.ok) return json({ error: 'voice_not_authorized', reason: va.reason, message: 'This voice is not authorized for your account. Pick a library voice or renew consent.' }, 403)
  } catch (e) {
    if (e instanceof VoiceRegistryError) return json({ error: e.code, message: e.message }, e.status)
    throw e
  }

  // ---- one active conversation per user — checked against LiveKit (B4), not just this instance's memory
  try {
    const found = new Set<string>()
    const cached = activeSession(id.userId)
    if (cached) found.add(cached.room)
    for (const r of await listOwnerRooms(id.userId)) found.add(r.room)
    // D #35: which of them does THIS device hold (valid signed ticket for that exact room)? Those are its own stale
    // sessions. Anything else is another device's live session: refuse unless the caller explicitly consents.
    const existing = await Promise.all(
      [...found].map(async (room) => ({
        room,
        mine: priorTicket ? (await verifySessionTicket(env.approvalSecret(), priorTicket, { sub: id.userId, room, allowExpired: true })).ok : false,
      })),
    )
    const plan = planExistingSessions(existing, b.replace)
    if (plan.action === 'conflict') {
      logEvent({ evt: 'session_start', status: 'denied', reason: 'session_active' })
      return json({ error: 'session_active', room: plan.room, otherDevice: plan.otherDevice, message: 'You already have a listening session running (on another device or in an earlier tab). Starting here will end it.' }, 409)
    }
    if (plan.action === 'replace') for (const room of plan.rooms) await closeExisting(id.userId, room, priorTicket)
  } catch (e) {
    logEvent({ evt: 'session_start', status: 'error', reason: 'livekit_unreachable', detail: (e as Error).message?.slice(0, 120) })
    return json({ error: 'livekit_unreachable', message: 'Could not reach LiveKit. Typing and phrases still work.' }, 502)
  }

  // ---- A10: monthly LiveKit agent-minute cap (worker-reported, durable). Refuse BEFORE reserving anything.
  const agentUsed = await agentMinutesThisMonth()
  if (agentUsed !== null && agentUsed + b.minutes > LIMITS.livekit.plannedAgentMinutes) {
    logEvent({ evt: 'session_start', status: 'denied', reason: 'agent_month_cap', used: agentUsed })
    return json({ error: 'budget', reason: 'agent_month_cap', message: 'This month\'s voice-worker minutes are used up. Typing, phrases and speech still work.' }, 429)
  }

  // ---- reserve listening minutes (user ∩ project ∩ durable, ref = room so ANY instance and the worker can
  // settle it — A3). Every failure path below RELEASES every layer (B3/A7).
  const now = Date.now()
  const room = newRoomName()
  const spend = await reserveSttSpend(id, req, b.minutes, room, now, b.sttProfile)
  if (!spend.ok) return json(spend.body, spend.status)
  const minutes = spend.minutes
  const sttDay = spend.day
  const sttReservationId = spend.durableId

  const conversationId = randomId(10)
  let roomCreated = false
  try {
    // B16: the owner's LiveKit identity is opaque + per room (HMAC of user id and room). The partner's browser lists
    // participant identities, so the user id must never be one. The user id stays server-side (sealed metadata + ticket).
    const ownerIdentity = await ownerParticipantIdentity(id.userId, room)
    const token = await ownerToken({ identity: ownerIdentity, room, mode: b.mode }) // mint BEFORE creating the room (B1 failed here after dispatch)
    const invite = b.mode === 'tabletop' ? null : await signInvite(room, id.userId)
    roomCreated = true
    await createRoomAndDispatch(
      room,
      // SEALED server bookkeeping (opaque to participants).
      { ownerIdentity: id.userId, ownerParticipant: ownerIdentity, conversationId, generation: 0, mode: b.mode, maxSessionMinutes: minutes, startedAt: now, sttMinutes: minutes, sttReservationId },
      // Worker-private configuration → agent DISPATCH metadata (never visible to room participants).
      { ownerIdentity, ownerSub: id.userId, conversationId, generation: 0, mode: b.mode, voiceId: b.voiceId, outputLanguage: b.outputLanguage, inputLanguages: b.inputLanguages, keyterms: b.keyterms, contextPrompt: b.contextPrompt, maxSessionMinutes: minutes, sttProfile: b.sttProfile },
    )
    // E48: durable conversation_sessions / session_members row (content-free bookkeeping; never blocks the session).
    void sessionOpen({ userId: id.userId, room, conversationId, mode: b.mode, generation: 0, maxMinutes: minutes, sttProfile: b.sttProfile })
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
    return json({ url: env.livekitUrl(), token, room, conversationId, invite, ticket, maxSessionMinutes: minutes, generation: 0, sttProfile: spend.profile })
  } catch (e) {
    // B3/B7: never leak the room or the reservation; return a JSON error instead of an empty 500.
    if (roomCreated) await deleteRoom(room)
    void sessionClose(room, 'error')
    rv().sessions.delete(id.userId)
    await spend.releaseAll()
    logEvent({ evt: 'session_start', status: 'error', room, reason: 'setup_failed', detail: (e as Error).message?.slice(0, 120) })
    return json({ error: 'session_start_failed', message: 'Could not start the listening room. No listening minutes were used.' }, 502)
  }
}

export const POST = withJsonErrors('livekit/session', handlePOST)
