/**
 * C — core conversation flow (client + server). Worker-side fixes are covered by worker/tests/test_c_*.py.
 *  #26 pending + onHeard · #20 attempt-scoped statuses · #27 supersede / refund / final retry · #28 visible limit
 *  #29 engaged lease · #30 serialized turns + revision guard · #31 stateless signed proof + fail-closed check
 */
import { describe, expect, it, vi } from 'vitest'
import { SpeechController, SPEECH_STATUS_TYPES, type PlayerLike, type SpeechDeps } from '@/lib/client/speech'
import { SerialQueue } from '@/lib/serial-queue'
import { EngageTracker, ENGAGE_MS } from '@/lib/engage'
import { CALLS_PER_TURN, FINAL_RETRY_MAX, finalRetryDelayMs, isRetryableSuggestError, SuggestionGate } from '@/lib/suggest-gate'
import { TurnTracker } from '@/lib/turns'
import { BudgetLedger } from '@/lib/budget'
import { evaluateCandidateSource, signCandidateProof, verifyCandidateProof, type CandidateProofPayload } from '@/lib/candidate-proof'
import { startFlight } from '@/lib/server/flight'
import { sha256Hex } from '@/lib/hash'
import type { Approval, TurnRef } from '@/lib/contracts'
import { SECRET, signed } from './helpers'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------------------------------------ #26 / #20
class FakePlayer implements PlayerLike {
  async unlock() {}
  begin() {}
  push() {}
  async drained() {}
  stop() {}
}
function setup(over: Partial<SpeechDeps> = {}) {
  const heard: { attemptId: string; text: string }[] = []
  const room = { speak: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const deps: SpeechDeps = {
    sha256: sha256Hex,
    approve: vi.fn(async (text: string) => signed(text)),
    directStream: vi.fn(async () => ({ body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4)); c.close() } }), sampleRate: 24000 })),
    room,
    route: () => 'room',
    roomAckTimeoutMs: 10_000,
    player: new FakePlayer(),
    onState: () => undefined,
    onHeard: (h) => heard.push({ attemptId: h.attemptId, text: h.text }),
    ...over,
  }
  return { c: new SpeechController(deps), heard, room, deps }
}

describe('C #26 — "said" is committed when audio actually starts', () => {
  it('room: dispatch returns pending and commits NOTHING until the worker says `speaking`', async () => {
    const { c, heard } = setup()
    expect(await c.request('Hello there', { partnerSpeaking: false })).toBe('pending')
    expect(heard).toEqual([])
    c.onWorkerStatus({ type: 'speaking', playbackAttemptId: c.activeAttempt! })
    expect(heard).toHaveLength(1)
    expect(heard[0].text).toBe('Hello there')
    c.onWorkerStatus({ type: 'done', playbackAttemptId: c.activeAttempt! })
    expect(heard).toHaveLength(1) // exactly once
  })

  it('room: a worker rejection commits nothing (the words are not recorded as said)', async () => {
    const { c, heard } = setup()
    await c.request('Too long for the cap', { partnerSpeaking: false })
    c.onWorkerStatus({ type: 'rejected', reason: 'session_char_cap', playbackAttemptId: c.activeAttempt! })
    expect(heard).toEqual([])
    expect(c.state.kind).toBe('error')
  })

  it('room: Stop before any audio commits nothing', async () => {
    const { c, heard } = setup()
    await c.request('Never mind', { partnerSpeaking: false })
    const a = c.activeAttempt!
    c.stop()
    c.onWorkerStatus({ type: 'speaking', playbackAttemptId: a }) // a late status of the stopped attempt
    expect(heard).toEqual([])
  })

  it('room: a short phrase whose `done` overtakes `speaking` is still committed once', async () => {
    const { c, heard } = setup()
    await c.request('Yes', { partnerSpeaking: false })
    c.onWorkerStatus({ type: 'done', playbackAttemptId: c.activeAttempt! })
    expect(heard).toHaveLength(1)
  })

  it('room: `uncertain` after audio started counts as said (never replayed) and ends in delivery_uncertain', async () => {
    const { c, heard } = setup()
    await c.request('Half said', { partnerSpeaking: false })
    c.onWorkerStatus({ type: 'uncertain', reason: 'synthesis_failed', playbackAttemptId: c.activeAttempt! })
    expect(heard).toHaveLength(1)
    expect(c.state.kind).toBe('delivery_uncertain')
  })

  it('direct: committed on the first audio chunk', async () => {
    const { c, heard } = setup({ route: () => 'direct', room: null })
    expect(await c.request('Direct words', { partnerSpeaking: false })).toBe('spoken')
    expect(heard.map((h) => h.text)).toEqual(['Direct words'])
  })

  it('direct: a stream that fails before any audio commits nothing', async () => {
    const { c, heard } = setup({
      route: () => 'direct',
      room: null,
      directStream: vi.fn(async () => ({ body: new ReadableStream<Uint8Array>({ start(ctrl) { ctrl.error(Object.assign(new Error('boom'), { code: 'network_error' })) } }), sampleRate: 24000 })),
    })
    expect(await c.request('Lost words', { partnerSpeaking: false })).toBe('error')
    expect(heard).toEqual([])
  })

  it('held for a gap commits nothing until it is actually spoken', async () => {
    const { c, heard } = setup({ route: () => 'direct', room: null })
    expect(await c.request('After you finish', { partnerSpeaking: true })).toBe('held')
    expect(heard).toEqual([])
    expect(await c.gap()).toBe('spoken')
    expect(heard).toHaveLength(1)
  })

  it('a worker that goes silent (no ack) falls back to HTTP TTS and commits that single utterance once', async () => {
    const { c, heard, room } = setup({ roomAckTimeoutMs: 15 })
    await c.request('Are you there?', { partnerSpeaking: false })
    await wait(60)
    expect(room.stop).toHaveBeenCalledTimes(1)
    expect(heard.map((h) => h.text)).toEqual(['Are you there?'])
  })
})

describe('C #20 — worker statuses are attempt-scoped', () => {
  it('a speech status WITHOUT an attempt id is ignored (it used to finish whatever was in flight)', async () => {
    const { c, heard } = setup()
    await c.request('In flight', { partnerSpeaking: false })
    for (const type of ['speaking', 'done', 'cancelled', 'uncertain', 'rejected', 'error']) {
      expect(c.onWorkerStatus({ type, reason: 'x' })).toBe(false)
    }
    expect(c.state.kind).toBe('speaking')
    expect(heard).toEqual([])
  })

  it('a status for another attempt is ignored; the right one is applied', async () => {
    const { c } = setup()
    await c.request('Mine', { partnerSpeaking: false })
    expect(c.onWorkerStatus({ type: 'done', playbackAttemptId: 'someone-elses' })).toBe(false)
    expect(c.state.kind).toBe('speaking')
    expect(c.onWorkerStatus({ type: 'done', playbackAttemptId: c.activeAttempt! })).toBe(true)
  })

  it('session-level statuses never touch the utterance in flight (paused / listening / reconnecting / ready / ended)', async () => {
    const { c } = setup()
    await c.request('Mine', { partnerSpeaking: false })
    for (const type of ['paused', 'listening', 'reconnecting', 'ready', 'ended']) {
      expect(SPEECH_STATUS_TYPES.has(type)).toBe(false)
      expect(c.onWorkerStatus({ type, playbackAttemptId: c.activeAttempt! })).toBe(false)
    }
    expect(c.state.kind).toBe('speaking')
  })

  it('a stale status after the utterance finished is ignored', async () => {
    const { c } = setup()
    await c.request('One', { partnerSpeaking: false })
    const a = c.activeAttempt!
    c.onWorkerStatus({ type: 'done', playbackAttemptId: a })
    expect(c.activeAttempt).toBeNull()
    expect(c.onWorkerStatus({ type: 'error', reason: 'late', playbackAttemptId: a })).toBe(false)
    expect(c.state.kind).toBe('idle')
  })
})

// ------------------------------------------------------------------------------------------------ #30
describe('C #30 — serialized turn queue + revision guard', () => {
  it('runs handlers one at a time in arrival order even when an earlier one is slower', async () => {
    const q = new SerialQueue()
    const out: string[] = []
    void q.push(async () => { await wait(30); out.push('first') })
    void q.push(async () => { await wait(1); out.push('second') })
    void q.push(() => { out.push('third') })
    await q.push(() => undefined)
    expect(out).toEqual(['first', 'second', 'third'])
    expect(q.pending).toBe(0)
  })

  it('clear() abandons queued tasks but not the chain; an erroring task does not stall it', async () => {
    const errors: unknown[] = []
    const q = new SerialQueue((e) => errors.push(e))
    const out: number[] = []
    void q.push(async () => { await wait(20); out.push(1) })
    void q.push(() => { out.push(2) })
    q.clear()
    void q.push(() => { throw new Error('bad') })
    await q.push(() => { out.push(3) })
    expect(out).toEqual([1, 3])
    expect(errors).toHaveLength(1)
  })

  it('a late/duplicate message numbered at or below the applied revision never overwrites a newer one', async () => {
    const t = new TurnTracker('c1')
    await t.apply({ turnId: 0, text: 'can you come on tuesday', endOfTurn: false, revision: 3 })
    const r = await t.apply({ turnId: 0, text: 'can you', endOfTurn: false, revision: 1 }) // reordered, older
    expect(r.changed).toBe(false)
    expect(t.get(0)!.text).toBe('can you come on tuesday')
    expect((await t.apply({ turnId: 0, text: 'can you come on tuesday', endOfTurn: false, revision: 3 })).changed).toBe(false) // retransmit
    const f = await t.apply({ turnId: 0, text: 'Can you come on Tuesday?', endOfTurn: true, revision: 4 })
    expect(f.changed).toBe(true)
    expect(t.get(0)!.endOfTurn).toBe(true)
  })

  it('messages without a revision (browser-direct STT) keep the old behaviour', async () => {
    const t = new TurnTracker('c1')
    await t.apply({ turnId: 0, text: 'one', endOfTurn: false })
    expect((await t.apply({ turnId: 0, text: 'one two', endOfTurn: false })).changed).toBe(true)
    expect((await t.apply({ turnId: 0, text: 'one two', endOfTurn: false })).changed).toBe(false)
  })

  it('a late partial after the final is still ignored', async () => {
    const t = new TurnTracker('c1')
    await t.apply({ turnId: 0, text: 'done here', endOfTurn: true, revision: 5 })
    expect((await t.apply({ turnId: 0, text: 'done', endOfTurn: false, revision: 6 })).changed).toBe(false)
  })
})

// ------------------------------------------------------------------------------------------------ #29
describe('C #29 — engagement is a lease that expires', () => {
  it('is active right after a touch, expires, and a new touch renews it', () => {
    const e = new EngageTracker()
    expect(e.active(0)).toBe(false) // never touched
    e.touch(1000)
    expect(e.active(1000 + ENGAGE_MS - 1)).toBe(true)
    expect(e.active(1000 + ENGAGE_MS)).toBe(false) // used to stay true forever after one tap
    e.touch(1000 + ENGAGE_MS + 5)
    expect(e.active(1000 + ENGAGE_MS + 6)).toBe(true)
  })
  it('reset() drops the lease at once (spoke / accepted the replacement / session change)', () => {
    const e = new EngageTracker()
    e.touch(0)
    e.reset()
    expect(e.active(1)).toBe(false)
  })
})

// ------------------------------------------------------------------------------------------------ #27 / #28 client side
describe('C #27/#28 — per-turn suggestion calls', () => {
  it('a failed or superseded call hands its slot back, so the FINAL request is not refused', () => {
    const g = new SuggestionGate()
    expect(g.begin(7, false, 'h1')).toBe('ok') // provisional
    g.fail(7, false, 'h1') // aborted by the newer request
    expect(g.remaining(7)).toBe(CALLS_PER_TURN)
    expect(g.begin(7, true, 'h2')).toBe('ok') // final
    expect(g.begin(7, false, 'h3')).toBe('ok')
    expect(g.begin(7, false, 'h4')).toBe('limit')
  })

  it('#28 the limit is visible: remaining() counts down to 0 and begin() reports `limit`', () => {
    const g = new SuggestionGate()
    expect(g.remaining(1)).toBe(CALLS_PER_TURN)
    g.begin(1, false, 'a')
    expect(g.remaining(1)).toBe(CALLS_PER_TURN - 1)
    g.begin(1, true, 'b')
    expect(g.remaining(1)).toBe(0)
    expect(g.begin(1, true, 'c')).toBe('limit')
    expect(g.remaining(undefined)).toBe(CALLS_PER_TURN)
    expect(g.remaining(99)).toBe(CALLS_PER_TURN) // a new partner turn unlocks more
  })

  it('fail() never clobbers a NEWER request\'s hash marker', () => {
    const g = new SuggestionGate()
    g.begin(1, false, 'old')
    g.begin(1, true, 'new')
    g.fail(1, false, 'old')
    expect(g.alreadyDrafted(1, 'new')).toBe(true)
  })

  it('auto-drafting: one provisional attempt per turn, even a failed one; a final is not redrafted when identical', () => {
    const g = new SuggestionGate()
    expect(g.hasProvisionalAttempt(3)).toBe(false)
    g.begin(3, false, 'p')
    g.fail(3, false, 'p')
    expect(g.hasProvisionalAttempt(3)).toBe(true) // no per-second retry loop on a failing provider
    g.begin(3, true, 'f')
    expect(g.alreadyDrafted(3, 'f')).toBe(true)
  })

  it('the FINAL request gets exactly ONE bounded retry', () => {
    const g = new SuggestionGate()
    expect(FINAL_RETRY_MAX).toBe(1)
    expect(g.takeFinalRetry(5)).toBe(true)
    expect(g.takeFinalRetry(5)).toBe(false)
    expect(g.takeFinalRetry(6)).toBe(true) // per partner turn
  })

  it('retry classification and bounded delay', () => {
    expect(isRetryableSuggestError('groq_error')).toBe(true)
    expect(isRetryableSuggestError('http_503')).toBe(true)
    expect(isRetryableSuggestError('boom', true)).toBe(true)
    expect(isRetryableSuggestError('budget')).toBe(false) // a budget decision is never retried around
    expect(isRetryableSuggestError('invalid_request')).toBe(false)
    expect(finalRetryDelayMs()).toBe(1500)
    expect(finalRetryDelayMs(100)).toBe(1500)
    expect(finalRetryDelayMs(60_000)).toBe(8000)
  })
})

// ------------------------------------------------------------------------------------------------ #27 server side
describe('C #27 — server budget refund + supersede', () => {
  const reserve = (l: BudgetLedger, turnKey: string, conv = 'c1') => l.reserveGroq({ conversationId: conv, turnKey, inputTokens: 100 })

  it('refundGroq gives back the in-flight slot, tokens, request count AND the per-turn call', () => {
    const l = new BudgetLedger()
    const before = l.snapshot().groq
    const r = reserve(l, 't')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(reserve(l, 't').ok).toBe(false) // one outstanding per conversation
    l.refundGroq(r.id)
    const after = l.snapshot().groq
    expect(after.requests).toBe(before.requests)
    expect(after.tokens).toBe(before.tokens)
    // both per-turn calls are available again
    const a = reserve(l, 't'); expect(a.ok).toBe(true); if (a.ok) l.commitGroq(a.id, 10)
    const b = reserve(l, 't'); expect(b.ok).toBe(true); if (b.ok) l.commitGroq(b.id, 10)
    expect(reserve(l, 't')).toMatchObject({ ok: false, reason: 'groq_turn_cap' })
  })

  it('without the refund a superseded draft used to burn a per-turn call (regression guard)', () => {
    const l = new BudgetLedger()
    const a = reserve(l, 't'); if (a.ok) l.releaseGroq(a.id) // old behaviour: slot kept
    const b = reserve(l, 't'); if (b.ok) l.commitGroq(b.id, 10)
    expect(reserve(l, 't')).toMatchObject({ ok: false, reason: 'groq_turn_cap' })
  })

  it('releaseGroq({refundTurn}) refunds only the per-turn call and keeps the request counted (bounded vs a flapping provider)', () => {
    const l = new BudgetLedger()
    const a = reserve(l, 't')
    if (a.ok) l.releaseGroq(a.id, { refundTurn: true })
    expect(l.snapshot().groq.requests).toBe(1)
    const b = reserve(l, 't'); if (b.ok) l.commitGroq(b.id, 10)
    const c = reserve(l, 't'); expect(c.ok).toBe(true) // the failed first call did not count against the turn
  })

  it('refundGroq is idempotent and ignores unknown ids', () => {
    const l = new BudgetLedger()
    const r = reserve(l, 't')
    if (!r.ok) throw new Error('x')
    l.refundGroq(r.id)
    l.refundGroq(r.id)
    l.refundGroq('nope')
    expect(l.snapshot().groq.requests).toBe(0)
  })

  it('startFlight: a newer request supersedes (aborts) the older and waits for its cleanup', async () => {
    const a = startFlight('u:conv', undefined, 500)
    expect(a.superseded).toBe(false)
    await a.ready
    const b = startFlight('u:conv', undefined, 500)
    expect(a.superseded).toBe(true)
    expect(a.signal.aborted).toBe(true)
    let bReady = false
    void b.ready.then(() => { bReady = true })
    await wait(10)
    expect(bReady).toBe(false) // still waiting for A's cleanup
    a.end()
    await b.ready
    expect(bReady).toBe(true)
    expect(b.superseded).toBe(false)
    b.end()
  })

  it('startFlight: the wait is bounded; flights for other conversations are independent; a client abort propagates', async () => {
    const a = startFlight('u:x', undefined, 20)
    const b = startFlight('u:x', undefined, 20)
    const t0 = Date.now()
    await b.ready // A never ends -> released by the bound
    expect(Date.now() - t0).toBeLessThan(500)
    const other = startFlight('u:y', undefined, 20)
    expect(other.superseded).toBe(false)
    expect(b.superseded).toBe(false)
    const parent = new AbortController()
    const c = startFlight('u:z', parent.signal)
    parent.abort()
    expect(c.signal.aborted).toBe(true)
    for (const f of [a, b, other, c]) f.end()
  })
})

// ------------------------------------------------------------------------------------------------ #31
const T = (over: Partial<TurnRef> = {}): TurnRef => ({ conversationId: 'conv1', generation: 0, turnId: 3, revision: 2, transcriptHash: 'a'.repeat(64), ...over })

async function fixture(over: { partner?: string; owner?: string; exp?: number } = {}) {
  const partner = over.partner ?? 'Can you come on Tuesday at three?'
  const turn = T({ transcriptHash: await sha256Hex(partner) })
  const text = 'Let me check my calendar.'
  const payload: CandidateProofPayload = {
    v: 1,
    owner: over.owner ?? 'user-1',
    set: 'set-1',
    turn,
    from: await sha256Hex(partner),
    cands: { c1: await sha256Hex(text), c2: await sha256Hex('Which Tuesday?') },
    exp: over.exp ?? Date.now() + 60_000,
  }
  const proof = await signCandidateProof(SECRET, payload)
  const current = { turn, text: partner }
  const body = { textHash: await sha256Hex(text), conversationId: 'conv1', generation: 0 }
  const source = { candidateSetId: 'set-1', candidateId: 'c1', turn, edited: false, proof, draftedFrom: partner, current }
  return { partner, turn, text, payload, proof, current, body, source }
}
const evalWith = (f: Awaited<ReturnType<typeof fixture>>, over: Record<string, unknown> = {}) =>
  evaluateCandidateSource({ secret: SECRET, owner: 'user-1', body: f.body, source: f.source, ...over } as Parameters<typeof evaluateCandidateSource>[0])

describe('C #31 — stateless signed candidate proof', () => {
  it('round-trips, and rejects tampering, a wrong secret, malformed input and expiry', async () => {
    const f = await fixture()
    const ok = await verifyCandidateProof(SECRET, f.proof)
    expect(ok.ok).toBe(true)
    expect((await verifyCandidateProof('another-secret-0123456789abcdef0123456789', f.proof))).toEqual({ ok: false, reason: 'bad_signature' })
    const [body, sig] = [f.proof.slice(0, f.proof.lastIndexOf('.')), f.proof.slice(f.proof.lastIndexOf('.') + 1)]
    const forged = btoa(JSON.stringify({ ...f.payload, owner: 'attacker' })).replace(/=+$/, '')
    expect(await verifyCandidateProof(SECRET, `${forged}.${sig}`)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await verifyCandidateProof(SECRET, `${body}.deadbeef`)).toEqual({ ok: false, reason: 'malformed' })
    expect(await verifyCandidateProof(SECRET, 'nodots')).toEqual({ ok: false, reason: 'malformed' })
    expect(await verifyCandidateProof(SECRET, f.proof, f.payload.exp + 1)).toEqual({ ok: false, reason: 'expired' })
  })

  it('a valid proof + an unchanged conversation is approved (works with NO server memory at all — any instance)', async () => {
    const f = await fixture()
    expect(await evalWith(f)).toEqual({ ok: true, turn: f.turn })
  })

  it('FAIL-CLOSED: no proof / forged proof / unverifiable state is refused (not skipped)', async () => {
    const f = await fixture()
    const noProof = await evalWith({ ...f, source: { ...f.source, proof: undefined } })
    expect(noProof).toMatchObject({ ok: false, status: 409, error: 'stale_candidate', reason: 'proof_missing' })
    expect(await evalWith({ ...f, source: { ...f.source, proof: f.proof.slice(0, -2) + 'ff' } })).toMatchObject({ ok: false, reason: 'invalid_proof' })
    expect(await evalWith({ ...f, source: { ...f.source, current: undefined } })).toMatchObject({ ok: false, reason: 'conversation_unverified' })
    expect(await evalWith({ ...f, source: { ...f.source, draftedFrom: undefined } })).toMatchObject({ ok: false, reason: 'conversation_unverified' })
    // the browser lies about the newest turn text: its hash must match
    expect(await evalWith({ ...f, source: { ...f.source, current: { turn: f.turn, text: 'something else entirely' } } })).toMatchObject({ ok: false, reason: 'conversation_unverified' })
    // lies about what the set answered
    expect(await evalWith({ ...f, source: { ...f.source, draftedFrom: 'Different partner text' } })).toMatchObject({ ok: false, reason: 'conversation_unverified' })
  })

  it('wrong owner, wrong set/turn binding, wrong conversation/generation and expiry are refused', async () => {
    const f = await fixture()
    expect(await evaluateCandidateSource({ secret: SECRET, owner: 'user-2', body: f.body, source: f.source })).toMatchObject({ ok: false, status: 403, error: 'wrong_user' })
    expect(await evalWith({ ...f, source: { ...f.source, candidateSetId: 'other-set' } })).toMatchObject({ ok: false, reason: 'invalid_proof' })
    expect(await evalWith({ ...f, source: { ...f.source, turn: { ...f.turn, revision: 9 } } })).toMatchObject({ ok: false, reason: 'invalid_proof' })
    expect(await evalWith({ ...f, body: { ...f.body, generation: 1 } })).toMatchObject({ ok: false, reason: 'conversation_changed' })
    expect(await evalWith({ ...f, body: { ...f.body, conversationId: 'conv2' } })).toMatchObject({ ok: false, reason: 'conversation_changed' })
    expect(await evalWith({ ...f, source: { ...f.source, candidateId: 'zzz' } })).toMatchObject({ ok: false, reason: 'invalid_proof' })
    const old = await fixture({ exp: Date.now() - 1 })
    expect(await evalWith(old)).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('an "unedited" candidate whose text differs is refused; an edited one is allowed (the owner wrote it)', async () => {
    const f = await fixture()
    const other = { ...f.body, textHash: await sha256Hex('Yes, I will pay you 5000 dollars.') }
    expect(await evalWith({ ...f, body: other })).toMatchObject({ ok: false, error: 'altered_text' })
    expect(await evalWith({ ...f, body: other, source: { ...f.source, edited: true } })).toMatchObject({ ok: true })
  })

  it('the Conversation Brake: a material change (negation / number) or a newer substantive turn invalidates', async () => {
    const f = await fixture()
    const negated = 'Can you NOT come on Tuesday at three?'
    const negTurn = T({ revision: 4, transcriptHash: await sha256Hex(negated) })
    expect(await evalWith({ ...f, source: { ...f.source, current: { turn: negTurn, text: negated } } })).toMatchObject({ ok: false, status: 409, reason: 'negation' })
    const changed = 'Can you come on Tuesday at four?'
    const numTurn = T({ revision: 4, transcriptHash: await sha256Hex(changed) })
    expect(await evalWith({ ...f, source: { ...f.source, current: { turn: numTurn, text: changed } } })).toMatchObject({ ok: false, reason: 'number_or_date' })
    const next = 'Also did you get the letter from the bank yesterday'
    const nextTurn = T({ turnId: 4, revision: 0, transcriptHash: await sha256Hex(next) })
    expect(await evalWith({ ...f, source: { ...f.source, current: { turn: nextTurn, text: next } } })).toMatchObject({ ok: false, reason: 'new_turn' })
    const filler = 'mm hm'
    const fillTurn = T({ turnId: 4, revision: 0, transcriptHash: await sha256Hex(filler) })
    expect(await evalWith({ ...f, source: { ...f.source, current: { turn: fillTurn, text: filler } } })).toMatchObject({ ok: true }) // a backchannel does not
  })

  it('a pure extension of the same sentence is not material', async () => {
    const f = await fixture()
    const ext = 'Can you come on Tuesday at three? Thanks'
    const t = T({ revision: 3, transcriptHash: await sha256Hex(ext) })
    expect(await evalWith({ ...f, source: { ...f.source, current: { turn: t, text: ext } } })).toMatchObject({ ok: true })
  })

  it('this instance\'s memory can only make the verdict STRICTER, never more lenient', async () => {
    const f = await fixture()
    const negated = 'Can you NOT come on Tuesday at three?'
    const mem = { ref: T({ revision: 5, transcriptHash: await sha256Hex(negated) }), text: negated }
    expect(await evalWith(f, { serverLatest: mem })).toMatchObject({ ok: false, reason: 'negation' })
    expect(await evalWith(f, { serverLatest: undefined })).toMatchObject({ ok: true })
    // memory from another conversation is ignored
    expect(await evalWith(f, { serverLatest: { ...mem, ref: { ...mem.ref, conversationId: 'other' } } })).toMatchObject({ ok: true })
  })

  it('the approval route no longer consults process memory for the candidate set (source check)', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(path.resolve(__dirname, '../src/app/api/approve/route.ts'), 'utf8')
    expect(src).toContain('evaluateCandidateSource')
    expect(src).not.toContain('getCandidates')
    expect(src).not.toMatch(/if \(set &&/)
    const sug = fs.readFileSync(path.resolve(__dirname, '../src/app/api/suggest/route.ts'), 'utf8')
    expect(sug).toContain('signCandidateProof')
    expect(sug).toContain('startFlight')
    expect(sug).toContain('refundGroq')
  })
})

// keep the helper import honest
void ({} as Approval)
