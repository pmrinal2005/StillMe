import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { guestPoolLedger, ledgerFor, projectLedger, recordCandidates, recordTurn } from '@/lib/server/state'
import { generateCandidates, GroqError, buildMessages } from '@/lib/server/groq'
import { CandidateSet, SuggestRequest } from '@/lib/contracts'
import { estimateTokens, LIMITS } from '@/lib/budget'
import { reserveGroqDurable, settleDurableId } from '@/lib/server/spend'
import { randomId, sha256Hex } from '@/lib/hash'
import { withJsonErrors } from '@/lib/server/route'
import { env } from '@/lib/server/env'
import { signCandidateProof } from '@/lib/candidate-proof'
import { startFlight } from '@/lib/server/flight'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const CANDIDATE_TTL_MS = 90_000

async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  const parsed = SuggestRequest.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request', issues: parsed.error.issues.slice(0, 5) }, 400)
  const body = parsed.data

  // Turn Passport integrity: the hash must match the partner text we are drafting from.
  if ((await sha256Hex(body.partnerText)) !== body.turn.transcriptHash) return json({ error: 'turn_hash_mismatch' }, 409)
  recordTurn(body.turn, body.partnerText)

  const inputTokens = estimateTokens(buildMessages(body).map((m) => m.content).join('\n'))
  const turnKey = `${body.turn.conversationId}:${body.turn.generation}:${body.turn.turnId}`

  // C #27: ONE outstanding request per conversation. A newer request SUPERSEDES the older one: the older is aborted and
  // fully refunded (including its per-turn slot) before the newer reserves, so the newer is never refused as
  // `groq_outstanding` / `groq_turn_cap` because of work that was already abandoned.
  const flight = startFlight(`${id.userId}:${body.turn.conversationId}`, req.signal)
  try {
    await flight.ready
    if (flight.superseded || flight.signal.aborted) return json({ error: 'superseded' }, 409)

    const u = ledgerFor(id.userId).reserveGroq({ conversationId: body.turn.conversationId, turnKey, inputTokens })
    if (!u.ok) return json({ error: 'budget', reason: u.reason, retryAfterMs: u.retryAfterMs }, 429)
    const p = projectLedger().reserveGroq({ conversationId: `${id.userId}:${body.turn.conversationId}`, turnKey: `${id.userId}:${turnKey}`, inputTokens })
    if (!p.ok) {
      ledgerFor(id.userId).releaseGroq(u.id)
      return json({ error: 'budget', reason: p.reason, retryAfterMs: p.retryAfterMs }, 429)
    }
    // B8: guests also draw from one shared guest pool.
    const gpool = id.kind === 'guest' ? guestPoolLedger().reserveGroq({ conversationId: `${id.userId}:${body.turn.conversationId}`, turnKey: `${id.userId}:${turnKey}`, inputTokens }) : null
    if (gpool && !gpool.ok) {
      ledgerFor(id.userId).releaseGroq(u.id)
      projectLedger().releaseGroq(p.id)
      return json({ error: 'budget', reason: 'guest_pool', retryAfterMs: gpool.retryAfterMs, message: 'Guest suggestion allowance is used up. Sign in for more.' }, 429)
    }
    const gpoolId = gpool?.ok ? gpool.id : undefined
    const releaseMemory = (refundTurn = false) => {
      ledgerFor(id.userId).releaseGroq(u.id, { refundTurn })
      projectLedger().releaseGroq(p.id, { refundTurn })
      if (gpoolId) guestPoolLedger().releaseGroq(gpoolId, { refundTurn })
    }
    /** Abandoned before Groq answered: give EVERYTHING back (slot, tokens, request count, per-turn call). */
    const refundMemory = () => {
      ledgerFor(id.userId).refundGroq(u.id)
      projectLedger().refundGroq(p.id)
      if (gpoolId) guestPoolLedger().refundGroq(gpoolId)
    }

    // A5/A6: DURABLE Groq reservation (daily requests + tokens per subject ∩ guest pool ∩ project). The in-memory
    // ledgers above are per instance only, so on serverless every cold instance used to grant a fresh daily quota.
    // Reserved at the worst case (input + max output), settled with the provider-reported total.
    const g = await reserveGroqDurable(id, req, inputTokens + LIMITS.groq.maxOutputTokens)
    if (!g.ok) {
      releaseMemory()
      return json(g.body, g.status)
    }

    try {
      const out = await generateCandidates(body, flight.signal)
      ledgerFor(id.userId).commitGroq(u.id, out.totalTokens)
      projectLedger().commitGroq(p.id, out.totalTokens)
      if (gpoolId) guestPoolLedger().commitGroq(gpoolId, out.totalTokens)
      await settleDurableId(g.durableId, 'groq', true, out.totalTokens)
      const now = Date.now()
      const set: CandidateSet = {
        id: randomId(12),
        turn: body.turn,
        status: body.final ? 'final' : 'provisional',
        outputLanguage: body.outputLanguage,
        voiceId: body.voiceId,
        createdAt: now,
        expiresAt: now + CANDIDATE_TTL_MS,
        candidates: out.candidates.map((c) => ({ ...c, id: randomId(8), text: c.text.trim() })),
      }
      // C #31: stateless signed proof — verifiable by ANY instance (the in-memory record below is only a best-effort extra).
      const cands: Record<string, string> = {}
      for (const c of set.candidates) cands[c.id] = await sha256Hex(c.text)
      set.proof = await signCandidateProof(env.approvalSecret(), {
        v: 1,
        owner: id.userId,
        set: set.id,
        turn: set.turn,
        from: await sha256Hex(body.partnerText),
        cands,
        exp: set.expiresAt,
      })
      const valid = CandidateSet.parse(set)
      recordCandidates(valid.id, {
        owner: id.userId,
        turn: valid.turn,
        draftedFrom: body.partnerText,
        expiresAt: valid.expiresAt,
        texts: Object.fromEntries(valid.candidates.map((c) => [c.id, c.text])),
      })
      console.log(JSON.stringify({ evt: 'suggest', tokens: out.totalTokens, status: valid.status }))
      return json({ set: valid })
    } catch (e) {
      // Superseded by a newer request, or the client went away, BEFORE Groq answered: nothing useful was produced.
      if (flight.signal.aborted && !(e instanceof GroqError && e.status >= 400)) {
        refundMemory()
        await settleDurableId(g.durableId, 'groq', false)
        return json({ error: 'superseded' }, 409)
      }
      releaseMemory(true) // no candidates were produced: the per-turn slot is handed back (see BudgetLedger.releaseGroq)
      // A rejected/failed request still counts as a request at Groq when it reached them (429/5xx); commit 0 tokens
      // but keep the request counted. Network/abort before Groq answered → release entirely.
      if (e instanceof GroqError) await settleDurableId(g.durableId, 'groq', true, 0)
      else await settleDurableId(g.durableId, 'groq', false)
      if (e instanceof GroqError) {
        if (e.status === 429 && e.retryAfter) {
          ledgerFor(id.userId).noteRetryAfter(e.retryAfter)
          projectLedger().noteRetryAfter(e.retryAfter)
        }
        return json({ error: 'groq_error', status: e.status }, e.status === 429 ? 429 : e.status === 503 ? 503 : 502, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {})
      }
      throw e
    }
  } finally {
    flight.end()
  }
}

export const POST = withJsonErrors('suggest', handlePOST)
