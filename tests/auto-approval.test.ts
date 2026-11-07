import { describe, expect, it } from 'vitest'
import { evaluateAutoApproval } from '@/lib/auto-approval'
import { signCandidateProof, type CandidateProofPayload } from '@/lib/candidate-proof'
import { sha256Hex } from '@/lib/hash'
import type { ApproveRequest } from '@/lib/contracts'
import { SECRET } from './helpers'

const OWNER = 'user-1'
const PARTNER = 'What did you think of the film last weekend'
const NOW = 1_700_000_000_000

async function fixture(over: { text?: string; intent?: string; risk?: string; partner?: string; edited?: boolean; owner?: string; noMeta?: boolean } = {}) {
  const text = over.text ?? 'That sounds interesting, tell me more.'
  const partner = over.partner ?? PARTNER
  const th = await sha256Hex(partner)
  const turn = { conversationId: 'conv1', generation: 0, turnId: 1, revision: 0, transcriptHash: th }
  const payload: CandidateProofPayload = {
    v: 1, owner: over.owner ?? OWNER, set: 'set1', turn, from: th, cands: { c1: await sha256Hex(text) },
    meta: over.noMeta ? undefined : { c1: { i: over.intent ?? 'continue', r: over.risk ?? 'none' } }, exp: NOW + 60_000,
  }
  const proof = await signCandidateProof(SECRET, payload)
  const source: NonNullable<ApproveRequest['source']> = { candidateSetId: 'set1', candidateId: 'c1', turn, edited: over.edited ?? false, proof, draftedFrom: partner }
  return { text, source }
}
const auto = { mode: 'turn_taking' as const, silenceMs: 2000, vetoMs: 3000 }
const run = async (f: Awaited<ReturnType<typeof fixture>>, o: Partial<Parameters<typeof evaluateAutoApproval>[0]> = {}) =>
  evaluateAutoApproval({ secret: SECRET, owner: OWNER, text: f.text, auto, source: f.source, rateAllow: () => true, now: NOW, ...o })

describe('server backstop for auto approvals', () => {
  it('accepts an unedited, non-committal, risk-none AI draft answering an ordinary turn', async () => {
    expect(await run(await fixture())).toEqual({ ok: true })
    expect(await run(await fixture({ intent: 'clarify', text: 'Could you say that again?' }))).toEqual({ ok: true })
  })
  it('refuses text with no AI-draft source (typed words are never "auto")', async () => {
    const f = await fixture()
    expect(await run(f, { source: undefined })).toMatchObject({ ok: false, reason: 'needs_ai_draft' })
  })
  it('refuses an edited draft', async () => {
    expect(await run(await fixture({ edited: true }))).toMatchObject({ ok: false, reason: 'edited' })
  })
  it('refuses a forged / missing / foreign proof', async () => {
    const f = await fixture()
    expect(await run({ ...f, source: { ...f.source, proof: undefined } })).toMatchObject({ ok: false, reason: 'proof_missing' })
    expect(await run({ ...f, source: { ...f.source, proof: f.source.proof!.slice(0, -2) + '00' } })).toMatchObject({ ok: false, reason: 'invalid_proof' })
    expect(await run(await fixture({ owner: 'someone-else' }))).toMatchObject({ ok: false, reason: 'wrong_user' })
  })
  it('refuses a proof from before intents were recorded (no meta) — fail closed', async () => {
    expect(await run(await fixture({ noMeta: true }))).toMatchObject({ ok: false, reason: 'meta_missing' })
  })
  it('refuses decline/custom intents and any non-"none" risk', async () => {
    expect(await run(await fixture({ intent: 'decline' }))).toMatchObject({ ok: false, reason: 'intent' })
    expect(await run(await fixture({ intent: 'custom' }))).toMatchObject({ ok: false, reason: 'intent' })
    expect(await run(await fixture({ risk: 'medical' }))).toMatchObject({ ok: false, reason: 'risk' })
  })
  it('refuses commitment-shaped text', async () => {
    for (const text of ['Yes, I agree.', 'I will pay you $20.', 'Meet at 5 then.']) {
      expect(await run(await fixture({ text })), text).toMatchObject({ ok: false, reason: 'content' })
    }
  })
  it('refuses when the partner turn it answers is sensitive or trivial', async () => {
    expect(await run(await fixture({ partner: 'Do you want me to call the doctor about the pain' }))).toMatchObject({ ok: false, reason: 'sensitive_topic' })
    expect(await run(await fixture({ partner: 'okay thanks' }))).toMatchObject({ ok: false, reason: 'turn_too_short' })
  })
  it('refuses out-of-range pause / veto settings', async () => {
    const f = await fixture()
    expect(await run(f, { auto: { ...auto, silenceMs: 200 } })).toMatchObject({ ok: false, reason: 'silence_range' })
    expect(await run(f, { auto: { ...auto, vetoMs: 0 } })).toMatchObject({ ok: false, reason: 'veto_range' })
  })
  it('rate-limits (429)', async () => {
    expect(await run(await fixture(), { rateAllow: () => false })).toMatchObject({ ok: false, status: 429, error: 'auto_rate_limited' })
  })
})
