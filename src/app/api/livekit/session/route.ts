import { z } from 'zod'
import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { ledgerFor, projectLedger } from '@/lib/server/state'
import { createRoomAndDispatch, newRoomName, ownerToken, signInvite } from '@/lib/server/livekit'
import { InputLanguage, OutputLanguage } from '@/lib/contracts'
import { randomId } from '@/lib/hash'
import { LIMITS } from '@/lib/budget'

export const dynamic = 'force-dynamic'

const Body = z.object({
  mode: z.enum(['tabletop', 'partner-link', 'remote']),
  voiceId: z.string().min(1).max(128),
  outputLanguage: OutputLanguage,
  inputLanguages: z.array(InputLanguage).max(4).default([]),
  keyterms: z.array(z.string().min(1).max(50)).max(30).default([]),
  minutes: z.number().int().min(1).max(LIMITS.assembly.interactiveSessionMinutes).default(LIMITS.assembly.interactiveSessionMinutes),
})

/** Start an explicit, bounded listening session (one active conversation per user). */
export async function POST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  if (!env.livekitUrl() || !env.livekitKey() || !env.livekitSecret()) return json({ error: 'livekit_not_configured' }, 503)
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request' }, 400)
  const b = parsed.data

  const u = ledgerFor(id.userId).reserveSttMinutes(b.minutes)
  if (!u.ok) return json({ error: 'budget', reason: u.reason }, 429)
  const p = projectLedger().reserveSttMinutes(u.minutes)
  if (!p.ok) return json({ error: 'budget', reason: p.reason }, 429)

  const room = newRoomName()
  const conversationId = randomId(10)
  await createRoomAndDispatch(room, {
    ownerIdentity: id.userId,
    conversationId,
    generation: 0,
    mode: b.mode,
    voiceId: b.voiceId,
    outputLanguage: b.outputLanguage,
    inputLanguages: b.inputLanguages,
    keyterms: b.keyterms,
    maxSessionMinutes: p.minutes,
  })
  const token = await ownerToken({ identity: id.userId, room, mode: b.mode })
  const invite = b.mode === 'tabletop' ? null : await signInvite(room, id.userId)
  return json({ url: env.livekitUrl(), token, room, conversationId, invite, maxSessionMinutes: p.minutes })
}
