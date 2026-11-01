import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { ledgerFor, projectLedger, recordCandidates, recordTurn } from '@/lib/server/state'
import { generateCandidates, GroqError, buildMessages } from '@/lib/server/groq'
import { CandidateSet, SuggestRequest } from '@/lib/contracts'
import { estimateTokens } from '@/lib/budget'
import { randomId, sha256Hex } from '@/lib/hash'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const CANDIDATE_TTL_MS = 90_000

export async function POST(req: Request) {
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
  const u = ledgerFor(id.userId).reserveGroq({ conversationId: body.turn.conversationId, turnKey, inputTokens })
  if (!u.ok) return json({ error: 'budget', reason: u.reason, retryAfterMs: u.retryAfterMs }, 429)
  const p = projectLedger().reserveGroq({ conversationId: `${id.userId}:${body.turn.conversationId}`, turnKey: `${id.userId}:${turnKey}`, inputTokens })
  if (!p.ok) {
    ledgerFor(id.userId).releaseGroq(u.id)
    return json({ error: 'budget', reason: p.reason, retryAfterMs: p.retryAfterMs }, 429)
  }

  try {
    const out = await generateCandidates(body, req.signal)
    ledgerFor(id.userId).commitGroq(u.id, out.totalTokens)
    projectLedger().commitGroq(p.id, out.totalTokens)
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
    ledgerFor(id.userId).releaseGroq(u.id)
    projectLedger().releaseGroq(p.id)
    if (e instanceof GroqError) {
      if (e.status === 429 && e.retryAfter) {
        ledgerFor(id.userId).noteRetryAfter(e.retryAfter)
        projectLedger().noteRetryAfter(e.retryAfter)
      }
      return json({ error: 'groq_error', status: e.status }, e.status === 429 ? 429 : e.status === 503 ? 503 : 502, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {})
    }
    throw e
  }
}
