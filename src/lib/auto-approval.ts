/**
 * Server-side backstop for AUTO turn-taking approvals (pure + injectable → unit-tested).
 *
 * The browser decides WHEN to propose an automatic reply; it must not be the only thing deciding WHAT may be spoken
 * automatically. When an approval request carries `auto`, the server independently re-checks, from the HMAC-signed
 * candidate proof (which the client cannot forge or edit), that:
 *   - the text is an UNEDITED AI draft the server itself produced for this device,
 *   - its intent is non-committal (continue / clarify) and its risk is "none" (both recorded inside the signed proof),
 *   - the text has no commitment-shaped content (money, links, "I agree", "I will" …),
 *   - the partner text it answers (bound by hash inside the proof) is not a health / money / consent / personal matter
 *     and is long enough to deserve a reply,
 *   - the declared pause and veto window are inside the allowed ranges, and
 *   - the device is not exceeding the automatic-reply rate.
 * Anything else is refused with `auto_not_allowed` — the owner can still pick or type the words and press Speak.
 */
import { verifyCandidateProof } from './candidate-proof'
import { isAutoSpeakable, isSensitivePartnerText, TURN_TAKING } from './turn-taking'
import type { ApproveRequest } from './contracts'
import type { Candidate } from './contracts'

export type AutoVerdict =
  | { ok: true }
  | { ok: false; status: 403 | 429; error: 'auto_not_allowed' | 'auto_rate_limited'; reason: string; message: string }

const deny = (reason: string, message: string, status: 403 | 429 = 403): AutoVerdict => ({ ok: false, status, error: status === 429 ? 'auto_rate_limited' : 'auto_not_allowed', reason, message })

export async function evaluateAutoApproval(opts: {
  secret: string
  owner: string
  text: string
  auto: NonNullable<ApproveRequest['auto']>
  source: ApproveRequest['source'] | undefined
  /** Returns false when this device already used its automatic replies for the window (per-instance counter). */
  rateAllow: () => boolean
  now?: number
}): Promise<AutoVerdict> {
  const { auto, source } = opts
  if (!source) return deny('needs_ai_draft', 'Automatic replies can only say an AI draft you did not edit.')
  if (source.edited) return deny('edited', 'Automatic replies can only say an unedited AI draft.')
  if (!source.proof) return deny('proof_missing', 'This suggestion cannot be verified for automatic speech.')
  const v = await verifyCandidateProof(opts.secret, source.proof, opts.now)
  if (!v.ok) return deny('invalid_proof', 'This suggestion cannot be verified for automatic speech.')
  const p = v.payload
  if (p.owner !== opts.owner) return deny('wrong_user', 'These suggestions belong to another device.')
  const m = p.meta?.[source.candidateId]
  if (!m) return deny('meta_missing', 'This suggestion was not marked safe for automatic speech.')
  const cand: Candidate = { id: source.candidateId, text: opts.text, intent: m.i as Candidate['intent'], risk: m.r as Candidate['risk'] }
  const intentOk = TURN_TAKING.allowedIntents.includes(cand.intent) || (cand.intent === 'decline' && auto.prefer === 'decline')
  if (!intentOk) return deny('intent', 'Only a neutral continuation or a clarifying question can be said automatically.')
  if (cand.risk !== 'none') return deny('risk', 'This reply touches an important topic, so it is not said automatically.')
  if (!isAutoSpeakable(cand)) return deny('content', 'This reply contains something that needs your own decision, so it is not said automatically.')
  const partner = source.draftedFrom ?? ''
  if (isSensitivePartnerText(partner)) return deny('sensitive_topic', 'The conversation sounds important, so replies are not automatic.')
  if (partner.trim().split(/\s+/).filter(Boolean).length < TURN_TAKING.minPartnerWords) return deny('turn_too_short', 'Nothing here needs an automatic reply.')
  if (auto.silenceMs < TURN_TAKING.silenceMs.min || auto.silenceMs > TURN_TAKING.silenceMs.max) return deny('silence_range', 'The pause setting is outside the allowed range.')
  if (auto.vetoMs < TURN_TAKING.vetoMs.min || auto.vetoMs > TURN_TAKING.vetoMs.max) return deny('veto_range', 'The cancel window is outside the allowed range.')
  if (!opts.rateAllow()) return deny('rate', 'Too many automatic replies in a short time. Wait a moment or choose your own words.', 429)
  return { ok: true }
}
