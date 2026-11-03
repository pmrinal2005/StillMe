import { z } from 'zod'
import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { ledgerFor, projectLedger } from '@/lib/server/state'
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
 * Browser-direct STT (trusted private demo ONLY; disabled unless REVOICE_ALLOW_BROWSER_STT=true).
 * Each mint reserves bounded listening minutes; the token's max session duration enforces the cap.
 */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  if (!env.allowBrowserStt()) return json({ error: 'browser_stt_disabled' }, 403)
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request' }, 400)
  const b = parsed.data
  const u = ledgerFor(id.userId).reserveSttMinutes(b.minutes)
  if (!u.ok) return json({ error: 'budget', reason: u.reason }, 429)
  const p = projectLedger().reserveSttMinutes(u.minutes)
  if (!p.ok) return json({ error: 'budget', reason: p.reason }, 429)
  const token = await mintSttToken(p.minutes * 60)
  return json({ wsUrl: sttWsUrl({ token, sampleRate: b.sampleRate, languageCodes: b.languageCodes, keyterms: b.keyterms }), maxSessionSeconds: p.minutes * 60 })
}

export const POST = withJsonErrors('stt-token', handlePOST)
