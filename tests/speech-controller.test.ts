import { describe, expect, it, vi } from 'vitest'
import { SpeechController, MAX_HOLD_MS, type SpeechDeps, type PlayerLike } from '@/lib/client/speech'
import type { Approval } from '@/lib/contracts'
import { sha256Hex } from '@/lib/hash'
import { signed } from './helpers'

class FakePlayer implements PlayerLike {
  pushed: { attemptId: string; bytes: number }[] = []
  stops = 0
  begun: string[] = []
  async unlock() {}
  begin(id: string) { this.begun.push(id) }
  push(id: string, c: Uint8Array) { this.pushed.push({ attemptId: id, bytes: c.length }) }
  async drained() {}
  stop() { this.stops++ }
}

function streamOf(chunks: Uint8Array[], opts: { failAfter?: number; gate?: Promise<void> } = {}) {
  let i = 0
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (opts.gate && i === 1) await opts.gate
      if (opts.failAfter !== undefined && i >= opts.failAfter) return ctrl.error(Object.assign(new Error('network'), { code: 'network_error' }))
      if (i < chunks.length) ctrl.enqueue(chunks[i++])
      else ctrl.close()
    },
  })
}

function setup(over: Partial<SpeechDeps> = {}) {
  const player = new FakePlayer()
  const ttsTexts: string[] = []
  const states: string[] = []
  let clock = 1_000_000
  const deps: SpeechDeps = {
    sha256: sha256Hex,
    approve: vi.fn(async (text: string) => signed(text, { now: clock })),
    directStream: vi.fn(async (_a: Approval, text: string) => {
      ttsTexts.push(text)
      return { body: streamOf([new Uint8Array(4), new Uint8Array(4)]), sampleRate: 24000 }
    }),
    player,
    onState: (s) => states.push(s.kind),
    now: () => clock,
    ...over,
  }
  const c = new SpeechController(deps)
  return { c, deps, player, ttsTexts, states, tick: (ms: number) => (clock += ms) }
}

describe('SpeechController invariants', () => {
  it('speaks only the exact approved text', async () => {
    const { c, ttsTexts, deps } = setup()
    expect(await c.request('Hello  world ', { partnerSpeaking: false })).toBe('spoken')
    expect(ttsTexts).toEqual(['Hello  world ']) // no trimming/rewriting after approval
    expect(deps.approve).toHaveBeenCalledTimes(1)
    expect(c.state.kind).toBe('idle')
  })

  it('editing never reaches TTS (no speculative synthesis)', async () => {
    const { c, ttsTexts } = setup()
    c.edit('draft one')
    c.edit('draft two')
    expect(ttsTexts).toEqual([])
    expect(c.state.kind).toBe('review')
  })

  it('a rejected approval produces no speech', async () => {
    const { c, ttsTexts } = setup({ approve: vi.fn(async () => { throw new Error('stale_candidate') }) })
    expect(await c.request('Yes', { partnerSpeaking: false })).toBe('rejected')
    expect(ttsTexts).toEqual([])
    expect(c.state.kind).toBe('error')
  })

  it('rejects a server approval whose hash differs from the displayed text', async () => {
    const { c, ttsTexts } = setup({ approve: vi.fn(async () => signed('something else')) })
    expect(await c.request('Yes', { partnerSpeaking: false })).toBe('rejected')
    expect(ttsTexts).toEqual([])
  })

  it('holds while the partner speaks and speaks at the gap', async () => {
    const { c, ttsTexts } = setup()
    expect(await c.request('I have a question', { partnerSpeaking: true })).toBe('held')
    expect(ttsTexts).toEqual([])
    expect(c.state.kind).toBe('approved_pending_gap')
    expect(await c.gap()).toBe('spoken')
    expect(ttsTexts).toEqual(['I have a question'])
  })

  it('Speak Now is a deliberate override of the hold', async () => {
    const { c, ttsTexts } = setup()
    await c.request('Wait', { partnerSpeaking: true })
    expect(await c.speakNow()).toBe('spoken')
    expect(ttsTexts).toEqual(['Wait'])
  })

  it('material context change cancels a held approval; a later gap does not speak', async () => {
    const { c, ttsTexts } = setup()
    await c.request('Yes, Tuesday', { partnerSpeaking: true })
    expect(c.contextChanged('negation')).toBe(true)
    expect(c.state.kind).toBe('review')
    expect(await c.gap()).toBe('none')
    expect(ttsTexts).toEqual([])
  })

  it('a hold that lasts too long expires and requires renewed approval', async () => {
    const { c, ttsTexts, tick } = setup()
    await c.request('Okay', { partnerSpeaking: true })
    tick(MAX_HOLD_MS + 1)
    expect(await c.gap()).toBe('expired')
    expect(ttsTexts).toEqual([])
  })

  it('Stop silences locally, aborts upstream, drops late frames, and never resumes', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let signal: AbortSignal | undefined
    const { c, player } = setup({
      directStream: vi.fn(async (_a, _t, s) => {
        signal = s
        return { body: streamOf([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)], { gate }), sampleRate: 24000 }
      }),
    })
    const p = c.request('A long message', { partnerSpeaking: false })
    await new Promise((r) => setTimeout(r, 5))
    c.stop()
    expect(player.stops).toBe(1)
    expect(signal?.aborted).toBe(true)
    release()
    expect(await p).toBe('stopped')
    expect(player.pushed.length).toBe(1) // only the frame before Stop
    expect(c.state.kind).toBe('interrupted')
  })

  it('network loss after audio → delivery uncertain, no automatic replay', async () => {
    const { c, deps } = setup({
      directStream: vi.fn(async () => ({ body: streamOf([new Uint8Array(4), new Uint8Array(4)], { failAfter: 1 }), sampleRate: 24000 })),
    })
    expect(await c.request('Important message', { partnerSpeaking: false })).toBe('uncertain')
    expect(c.state.kind).toBe('delivery_uncertain')
    await new Promise((r) => setTimeout(r, 10))
    expect(deps.directStream).toHaveBeenCalledTimes(1)
  })

  it('failure before any audio → error (nothing heard), still no retry', async () => {
    const { c, deps } = setup({ directStream: vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'tts_unavailable' }) }) })
    expect(await c.request('Hi', { partnerSpeaking: false })).toBe('error')
    expect(c.state.kind).toBe('error')
    expect(deps.directStream).toHaveBeenCalledTimes(1)
  })

  it('explicit replay after uncertainty obtains a NEW approval', async () => {
    let fail = true
    const { c, deps } = setup({
      directStream: vi.fn(async () => ({ body: streamOf([new Uint8Array(4), new Uint8Array(4)], fail ? { failAfter: 1 } : {}), sampleRate: 24000 })),
    })
    await c.request('Hello', { partnerSpeaking: false })
    fail = false
    c.reset()
    expect(await c.request('Hello', { partnerSpeaking: false })).toBe('spoken')
    expect(deps.approve).toHaveBeenCalledTimes(2)
  })

  it('one utterance at a time', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { c } = setup({ directStream: vi.fn(async () => ({ body: streamOf([new Uint8Array(4), new Uint8Array(4)], { gate }), sampleRate: 24000 })) })
    const p = c.request('First', { partnerSpeaking: false })
    await new Promise((r) => setTimeout(r, 5))
    expect(await c.request('Second', { partnerSpeaking: false })).toBe('busy')
    release()
    await p
  })

  it('budget 429 pauses for budget', async () => {
    const { c } = setup({ directStream: vi.fn(async () => { throw Object.assign(new Error('budget'), { status: 429, code: 'tts_daily_chars' }) }) })
    await c.request('Hi', { partnerSpeaking: false })
    expect(c.state.kind).toBe('paused_for_budget')
  })

  it('room mode: worker synthesizes; late statuses for other attempts are ignored; room loss → uncertain', async () => {
    const room = { speak: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const { c, ttsTexts } = setup({ room })
    await c.request('Through the room', { partnerSpeaking: false })
    expect(ttsTexts).toEqual([])
    expect(room.speak).toHaveBeenCalledTimes(1)
    c.onWorkerStatus({ type: 'done', playbackAttemptId: 'someone-elses-attempt' })
    expect(c.state.kind).toBe('speaking')
    c.onWorkerStatus({ type: 'speaking', playbackAttemptId: c.activeAttempt! })
    c.onRoomLost()
    expect(c.state.kind).toBe('delivery_uncertain')
  })

  it('room mode Stop tells the worker to cancel', async () => {
    const room = { speak: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const { c } = setup({ room })
    const a = await c.request('Hello', { partnerSpeaking: false })
    expect(a).toBe('pending') // C #26: dispatched to the worker, NOT yet heard
    const attempt = c.activeAttempt!
    c.stop()
    expect(room.stop).toHaveBeenCalledTimes(1)
    c.onWorkerStatus({ type: 'done', playbackAttemptId: attempt })
    expect(c.state.kind).toBe('interrupted')
  })

  it('cacheable phrases are served from the authorized cache without TTS', async () => {
    const cache = { get: vi.fn(async () => ({ pcm: new ArrayBuffer(8), sampleRate: 24000 })), put: vi.fn(async () => {}) }
    const { c, ttsTexts, deps } = setup({ cache })
    expect(await c.request('Thank you', { partnerSpeaking: false, cacheable: true })).toBe('spoken')
    expect(ttsTexts).toEqual([])
    expect(deps.approve).toHaveBeenCalledTimes(1) // still requires an approval
  })
})
