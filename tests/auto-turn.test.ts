import { describe, expect, it, vi } from 'vitest'
import { AutoTurnController, type AutoConfig, type AutoContext } from '@/lib/client/auto-turn'
import type { Candidate, CandidateSet } from '@/lib/contracts'
import type { AutoView } from '@/lib/turn-taking'

const H = 'a'.repeat(64)
const TEXT = 'What did you think of the film last weekend'

function mkSet(over: Partial<CandidateSet> = {}, cands?: Candidate[], turnHash = H): CandidateSet {
  return {
    id: 's1', turn: { conversationId: 'c', generation: 0, turnId: 1, revision: 0, transcriptHash: turnHash }, status: 'final', outputLanguage: 'english', voiceId: 'aai-audrey',
    createdAt: 0, expiresAt: 10_000_000,
    candidates: cands ?? [
      { id: 'a', text: 'Mm, tell me more about it.', intent: 'continue', risk: 'none' },
      { id: 'b', text: 'Which film do you mean?', intent: 'clarify', risk: 'none' },
      { id: 'c', text: 'Not right now, thanks.', intent: 'decline', risk: 'none' },
    ],
    ...over,
  }
}

function setup(over: { cfg?: Partial<AutoConfig>; ctx?: Partial<AutoContext>; draft?: (t: { turnId: number; hash: string; text: string }) => Promise<CandidateSet | null>; stale?: () => string | null; speak?: () => Promise<'started' | 'rejected'> } = {}) {
  let t = 1_000_000
  const cfg: AutoConfig = { enabled: true, silenceMs: 2000, vetoMs: 3000, askFirst: false, maxConsecutive: 3, prefer: 'continue', ...over.cfg }
  const ctx: AutoContext = { sessionActive: true, listening: 'listening', online: true, outputKind: 'idle', composerText: '', ownerEngaged: false, suggestionsAvailable: true, ...over.ctx }
  const views: AutoView[] = []
  const events: { type: string; reason?: string }[] = []
  const speak = vi.fn(over.speak ?? (async () => 'started' as const))
  const ensureDraft = vi.fn(over.draft ?? (async (_t: { turnId: number; hash: string; text: string }) => mkSet()))
  const c = new AutoTurnController({
    now: () => t, config: () => cfg, context: () => ctx, ensureDraft, staleness: over.stale ?? (() => null), speak, onView: (v) => views.push(v), onEvent: (e) => events.push(e),
  })
  const advance = async (ms: number, step = 100) => {
    for (let i = 0; i < ms; i += step) {
      t += step
      c.tick()
      await Promise.resolve()
      await Promise.resolve()
    }
  }
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }
  const finalTurn = (turnId = 1, text = TEXT) => c.turnUpdate({ turnId, hash: H, endOfTurn: true, text })
  return { c, cfg, ctx, views, events, speak, ensureDraft, advance, flush, finalTurn, get t() { return t }, set t(v: number) { t = v } }
}

describe('AutoTurnController — happy path', () => {
  it('pause → draft → visible countdown → speaks the picked unedited AI draft with the auto flag', async () => {
    const s = setup()
    s.finalTurn()
    await s.advance(1900)
    expect(s.ensureDraft).not.toHaveBeenCalled()
    await s.advance(300) // 2.0 s of silence reached
    await s.flush()
    expect(s.ensureDraft).toHaveBeenCalledTimes(1)
    const cd = s.views.filter((v) => v.phase === 'countdown')
    expect(cd.length).toBeGreaterThan(0)
    expect(cd[0].candidateText).toBe('Mm, tell me more about it.')
    expect(s.speak).not.toHaveBeenCalled() // veto window still open
    await s.advance(2500) // countdown started ~2.0 s in; still inside the 3.0 s veto window
    expect(s.speak).not.toHaveBeenCalled()
    await s.advance(1000)
    await s.flush()
    expect(s.speak).toHaveBeenCalledTimes(1)
    const [set, cand, auto] = s.speak.mock.calls[0] as unknown as [CandidateSet, Candidate, { mode: string; silenceMs: number; vetoMs: number }]
    expect(set.id).toBe('s1')
    expect(cand.text).toBe('Mm, tell me more about it.')
    expect(auto).toEqual({ mode: 'turn_taking', silenceMs: 2000, vetoMs: 3000 })
  })
  it('honours "clarify" preference', async () => {
    const s = setup({ cfg: { prefer: 'clarify' } })
    s.finalTurn()
    await s.advance(2200)
    await s.flush()
    await s.advance(3500)
    await s.flush()
    expect((s.speak.mock.calls[0] as unknown as [unknown, Candidate])[1].text).toBe('Which film do you mean?')
  })
})

describe('AutoTurnController — never speaks when it must not', () => {
  it('does nothing while disabled (the default posture)', async () => {
    const s = setup({ cfg: { enabled: false } })
    s.finalTurn()
    await s.advance(12_000)
    expect(s.ensureDraft).not.toHaveBeenCalled()
    expect(s.speak).not.toHaveBeenCalled()
    expect(s.views[s.views.length - 1]?.phase ?? 'off').toBe('off')
  })
  it('does not even draft for a sensitive partner turn, and tells the owner why', async () => {
    const s = setup()
    s.finalTurn(1, 'Do you agree to sign the contract today')
    await s.advance(3000)
    expect(s.ensureDraft).not.toHaveBeenCalled()
    expect(s.views.some((v) => v.phase === 'blocked' && v.blockedReason === 'sensitive_topic')).toBe(true)
  })
  it('owner cancel during the veto window → nothing is spoken', async () => {
    const s = setup()
    s.finalTurn()
    await s.advance(2300)
    await s.flush()
    await s.advance(1000)
    expect(s.c.cancel()).toBe(true)
    await s.advance(6000)
    expect(s.speak).not.toHaveBeenCalled()
    expect(s.events.some((e) => e.type === 'cancelled')).toBe(true)
  })
  it('owner starts typing during the countdown → cancelled', async () => {
    const s = setup()
    s.finalTurn()
    await s.advance(2300)
    await s.flush()
    s.ctx.composerText = 'I would like'
    await s.advance(500)
    await s.advance(4000)
    expect(s.speak).not.toHaveBeenCalled()
  })
  it('partner speaks again during the countdown → cancelled', async () => {
    const s = setup()
    s.finalTurn()
    await s.advance(2300)
    await s.flush()
    s.c.voice(true)
    await s.advance(500)
    s.c.voice(false)
    await s.advance(5000)
    expect(s.speak).not.toHaveBeenCalled()
    expect(s.events.some((e) => e.type === 'cancelled' && e.reason === 'partner_resumed')).toBe(true)
  })
  it('a newer partner turn during the countdown → cancelled (the draft answers old words)', async () => {
    const s = setup()
    s.finalTurn()
    await s.advance(2300)
    await s.flush()
    s.c.turnUpdate({ turnId: 2, hash: 'b'.repeat(64), endOfTurn: false, text: 'actually wait' })
    await s.advance(5000)
    expect(s.speak).not.toHaveBeenCalled()
  })
  it('conversation brake (stale) at any point → cancelled', async () => {
    let stale: string | null = null
    const s = setup({ stale: () => stale })
    s.finalTurn()
    await s.advance(2300)
    await s.flush()
    stale = 'negation'
    await s.advance(5000)
    expect(s.speak).not.toHaveBeenCalled()
  })
  it('output becoming busy / listening pausing / going offline cancels', async () => {
    for (const patch of [{ outputKind: 'speaking' }, { listening: 'paused' }, { online: false }, { sessionActive: false }] as Partial<AutoContext>[]) {
      const s = setup()
      s.finalTurn()
      await s.advance(2300)
      await s.flush()
      Object.assign(s.ctx, patch)
      await s.advance(5000)
      expect(s.speak, JSON.stringify(patch)).not.toHaveBeenCalled()
    }
  })
  it('switching the feature off mid-countdown cancels it', async () => {
    const s = setup()
    s.finalTurn()
    await s.advance(2300)
    await s.flush()
    s.cfg.enabled = false
    await s.advance(5000)
    expect(s.speak).not.toHaveBeenCalled()
  })
  it('no safe candidate (all decline/custom or risky) → nothing is spoken and the owner is told', async () => {
    const s = setup({ draft: async () => mkSet({}, [
      { id: 'a', text: 'Yes, I agree to that.', intent: 'continue', risk: 'none' },
      { id: 'b', text: 'Is that a medical matter?', intent: 'clarify', risk: 'medical' },
      { id: 'c', text: 'No.', intent: 'decline', risk: 'none' },
    ]) })
    s.finalTurn()
    await s.advance(2300)
    await s.flush()
    await s.advance(4000)
    expect(s.speak).not.toHaveBeenCalled()
    expect(s.views.some((v) => v.blockedReason === 'no_safe_candidate')).toBe(true)
  })
  it('draft failure, a provisional set, or a set for a different turn → nothing spoken', async () => {
    for (const draft of [async () => null, async () => mkSet({ status: 'provisional' }), async () => mkSet({}, undefined, 'c'.repeat(64))]) {
      const s = setup({ draft })
      s.finalTurn()
      await s.advance(2300)
      await s.flush()
      await s.advance(5000)
      expect(s.speak).not.toHaveBeenCalled()
    }
  })
  it('a draft that throws is treated as failure', async () => {
    const s = setup({ draft: async () => { throw new Error('boom') } })
    s.finalTurn()
    await s.advance(2300)
    await s.flush()
    await s.advance(5000)
    expect(s.speak).not.toHaveBeenCalled()
    expect(s.views.some((v) => v.blockedReason === 'draft_failed')).toBe(true)
  })
  it('cancel during drafting discards the result', async () => {
    let resolve!: (s: CandidateSet) => void
    const s = setup({ draft: () => new Promise<CandidateSet>((r) => { resolve = r }) })
    s.finalTurn()
    await s.advance(2300)
    expect(s.c.cancel()).toBe(true)
    resolve(mkSet())
    await s.flush()
    await s.advance(6000)
    expect(s.speak).not.toHaveBeenCalled()
  })
  it('reset() (session ended) discards a pending draft and clears state', async () => {
    let resolve!: (s: CandidateSet) => void
    const s = setup({ draft: () => new Promise<CandidateSet>((r) => { resolve = r }) })
    s.finalTurn()
    await s.advance(2300)
    s.c.reset()
    resolve(mkSet())
    await s.flush()
    await s.advance(6000)
    expect(s.speak).not.toHaveBeenCalled()
  })
  it('server refusing the approval → nothing is said and the owner is told', async () => {
    const s = setup({ speak: async () => 'rejected' })
    s.finalTurn()
    await s.advance(2300)
    await s.flush()
    await s.advance(3500)
    await s.flush()
    expect(s.speak).toHaveBeenCalledTimes(1)
    expect(s.views.some((v) => v.blockedReason === 'rejected')).toBe(true)
  })
  it('never answers the same turn twice', async () => {
    const s = setup()
    s.finalTurn()
    await s.advance(2300)
    await s.flush()
    await s.advance(3500)
    await s.flush()
    await s.advance(20_000)
    expect(s.ensureDraft).toHaveBeenCalledTimes(1)
    expect(s.speak).toHaveBeenCalledTimes(1)
  })
})

describe('AutoTurnController — switching on', () => {
  it('never answers words that were spoken before the feature was switched on', async () => {
    const s = setup({ cfg: { enabled: false } })
    s.finalTurn()
    await s.advance(5000) // feature is off while the partner finishes and a pause passes
    s.cfg.enabled = true
    await s.advance(8000)
    await s.flush()
    expect(s.ensureDraft).not.toHaveBeenCalled()
    expect(s.speak).not.toHaveBeenCalled()
    // ...but the NEXT turn is handled normally
    s.finalTurn(2, 'And what about the book you were reading')
    await s.advance(2300)
    await s.flush()
    expect(s.ensureDraft).toHaveBeenCalledTimes(1)
  })
  it('cancel events are counted once (cancelled), not also as blocked', async () => {
    const s = setup()
    s.finalTurn()
    await s.advance(2300)
    await s.flush()
    s.c.cancel()
    expect(s.events.filter((e) => e.type === 'cancelled')).toHaveLength(1)
    expect(s.events.filter((e) => e.type === 'blocked')).toHaveLength(0)
  })
})

describe('AutoTurnController — pacing caps', () => {
  async function converse(s: ReturnType<typeof setup>, turnId: number) {
    s.finalTurn(turnId, `Turn number ${turnId} about what we should have for dinner`)
    await s.advance(2300)
    await s.flush()
    await s.advance(3500)
    await s.flush()
  }
  it('stops after N consecutive auto replies until the owner acts themself', async () => {
    const s = setup({ cfg: { maxConsecutive: 2 }, draft: async () => mkSet({ turn: { conversationId: 'c', generation: 0, turnId: 1, revision: 0, transcriptHash: H } }) })
    // each turn gets its own set bound to that turn
    s.ensureDraft.mockImplementation(async (t: { turnId: number; hash: string }) => mkSet({ turn: { conversationId: 'c', generation: 0, turnId: t.turnId, revision: 0, transcriptHash: t.hash } }))
    await converse(s, 1)
    await s.advance(7000)
    await converse(s, 2)
    expect(s.speak).toHaveBeenCalledTimes(2)
    await s.advance(7000)
    await converse(s, 3)
    expect(s.speak).toHaveBeenCalledTimes(2) // capped
    expect(s.views.some((v) => v.blockedReason === 'consecutive_cap')).toBe(true)
    s.c.manualAction() // owner typed/spoke something
    await s.advance(7000)
    await converse(s, 4)
    expect(s.speak).toHaveBeenCalledTimes(3)
  })
  it('enforces the minimum gap between two auto replies', async () => {
    const s = setup()
    s.ensureDraft.mockImplementation(async (t: { turnId: number; hash: string }) => mkSet({ turn: { conversationId: 'c', generation: 0, turnId: t.turnId, revision: 0, transcriptHash: t.hash } }))
    await (async () => { s.finalTurn(1, 'First thing I wanted to tell you today'); await s.advance(2300); await s.flush(); await s.advance(3500); await s.flush() })()
    expect(s.speak).toHaveBeenCalledTimes(1)
    // second final turn arrives right away; guards at fire time see the cooldown (< 6 s since the last auto reply)
    s.finalTurn(2, 'Second thing I wanted to tell you today')
    await s.advance(2200)
    await s.flush()
    expect(s.ensureDraft).toHaveBeenCalledTimes(1)
  })
})

describe('AutoTurnController — ask-first mode and explicit tap', () => {
  it('waits for a tap, never speaks on its own, and expires', async () => {
    const s = setup({ cfg: { askFirst: true } })
    s.finalTurn()
    await s.advance(2300)
    await s.flush()
    await s.advance(15_000)
    expect(s.speak).not.toHaveBeenCalled()
    expect(s.views.some((v) => v.phase === 'countdown' && v.awaitTap)).toBe(true)
    await s.advance(8000)
    expect(s.speak).not.toHaveBeenCalled()
    expect(s.views.some((v) => v.blockedReason === 'expired')).toBe(true)
  })
  it('tapping says it as an ordinary manual approval (no auto flag)', async () => {
    const s = setup({ cfg: { askFirst: true } })
    s.finalTurn()
    await s.advance(2300)
    await s.flush()
    expect(await s.c.confirmNow()).toBe(true)
    expect(s.speak).toHaveBeenCalledTimes(1)
    expect((s.speak.mock.calls[0] as unknown[])[2]).toBeUndefined()
  })
  it('tapping a stale proposal does nothing', async () => {
    let stale: string | null = null
    const s = setup({ cfg: { askFirst: true }, stale: () => stale })
    s.finalTurn()
    await s.advance(2300)
    await s.flush()
    stale = 'new_turn'
    expect(await s.c.confirmNow()).toBe(false)
    expect(s.speak).not.toHaveBeenCalled()
  })
})

describe('AutoTurnController — view model', () => {
  it('reports hearing → silence → drafting → countdown', async () => {
    const s = setup()
    s.c.turnUpdate({ turnId: 1, hash: H, endOfTurn: false, text: 'What did you think' })
    await s.advance(300)
    expect(s.views[s.views.length - 1].phase).toBe('hearing')
    s.finalTurn()
    await s.advance(1000)
    expect(s.views[s.views.length - 1].phase).toBe('silence')
    await s.advance(1300)
    await s.flush()
    const phases = s.views.map((v) => v.phase)
    expect(phases).toContain('drafting')
    expect(phases).toContain('countdown')
  })
})
