/**
 * Regression tests for B5 (no fallback when the worker is absent) and B6 (partner-link plays the
 * synthetic voice on both devices → ReVOICE's own speech transcribed as partner input).
 */
import { describe, expect, it, vi } from 'vitest'
import { SpeechController, type PlayerLike, type SpeechDeps } from '@/lib/client/speech'
import { WorkerPresenceMonitor } from '@/lib/client/worker-presence'
import { echoTailMs, OWNER_FALLBACK_GATES_WORKER, ownerPlaysLocally, partnerPlaysLocally } from '@/lib/audio-routing'
import { ControlMessage, type Approval } from '@/lib/contracts'
import { sha256Hex } from '@/lib/hash'
import { signed } from './helpers'

// ------------------------------------------------------------------ helpers
class FakePlayer implements PlayerLike {
  pushed: string[] = []
  async unlock() {}
  begin() {}
  push(id: string) { this.pushed.push(id) }
  async drained() {}
  stop() {}
}

const pcm = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(4))
      c.close()
    },
  })

type Route = 'room' | 'direct'

function setup(opts: { route: () => Route; room?: SpeechDeps['room']; ackMs?: number }) {
  const approvals: Route[] = []
  const direct: { text: string; roomName: string | null }[] = []
  const fallbacks: string[] = []
  const states: string[] = []
  const deps: SpeechDeps = {
    sha256: sha256Hex,
    approve: vi.fn(async (text: string, _h: string, _s, route: Route) => {
      approvals.push(route)
      // Mirrors the app: room approvals are room-bound, direct approvals carry roomName=null.
      return signed(text, route === 'direct' ? { over: { roomName: undefined } } : {})
    }),
    directStream: vi.fn(async (a: Approval, text: string) => {
      direct.push({ text, roomName: a.roomName })
      return { body: pcm(), sampleRate: 24000 }
    }),
    room: opts.room ?? { speak: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
    route: opts.route,
    onRouteFallback: (r) => fallbacks.push(r),
    roomAckTimeoutMs: opts.ackMs ?? 20,
    player: new FakePlayer(),
    onState: (s) => states.push(s.kind),
  }
  return { c: new SpeechController(deps), deps, approvals, direct, fallbacks, states }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ B5: presence monitor
describe('B5 — worker presence monitor', () => {
  function clock() {
    let t = 1_000
    return { now: () => t, tick: (ms: number) => (t += ms) }
  }

  it('does not route through the room until the worker is confirmed present', () => {
    const k = clock()
    const m = new WorkerPresenceMonitor({ now: k.now })
    expect(m.route()).toBe('direct') // connecting
    m.connected()
    expect(m.state).toBe('waiting')
    expect(m.route()).toBe('direct')
    m.agentJoined()
    expect(m.route()).toBe('direct') // present but not yet ready
    m.workerReady()
    expect(m.state).toBe('ready')
    expect(m.route()).toBe('room')
  })

  it('older workers without a ready reply become usable after the grace period', () => {
    const k = clock()
    const m = new WorkerPresenceMonitor({ now: k.now, readyGraceMs: 4_000 })
    m.connected()
    m.agentJoined()
    k.tick(3_999)
    m.tick()
    expect(m.route()).toBe('direct')
    k.tick(2)
    m.tick()
    expect(m.route()).toBe('room')
  })

  it('a worker that never joins → absent (notice) and then ends the session exactly once', () => {
    const k = clock()
    const m = new WorkerPresenceMonitor({ now: k.now, joinTimeoutMs: 12_000, absentEndMs: 45_000 })
    m.connected()
    k.tick(12_000)
    expect(m.tick()).toBeNull()
    expect(m.state).toBe('absent')
    expect(m.snapshot()).toMatchObject({ route: 'direct', reason: 'worker_absent' })
    k.tick(33_000)
    expect(m.tick()).toBe('end')
    k.tick(10_000)
    expect(m.tick()).toBeNull() // never twice
  })

  it('a late worker rescues an absent session before auto-end', () => {
    const k = clock()
    const m = new WorkerPresenceMonitor({ now: k.now })
    m.connected()
    k.tick(20_000)
    m.tick()
    expect(m.state).toBe('absent')
    m.agentJoined()
    m.workerReady()
    expect(m.route()).toBe('room')
    k.tick(60_000)
    expect(m.tick()).toBeNull()
  })

  it('a worker that leaves → lost (direct), back to room if it returns, auto-end if it does not', () => {
    const k = clock()
    const m = new WorkerPresenceMonitor({ now: k.now, lostEndMs: 30_000 })
    m.connected()
    m.agentJoined()
    m.workerReady()
    m.agentLeft()
    expect(m.state).toBe('lost')
    expect(m.route()).toBe('direct')
    m.agentJoined()
    m.workerReady()
    expect(m.route()).toBe('room')
    m.agentLeft()
    k.tick(30_000)
    expect(m.tick()).toBe('end')
  })

  it('a failed room delivery degrades the route until the worker answers a fresh hello', () => {
    const m = new WorkerPresenceMonitor()
    m.connected()
    m.agentJoined()
    m.workerReady()
    m.degrade('worker_no_ack')
    expect(m.snapshot()).toMatchObject({ state: 'degraded', route: 'direct', reason: 'worker_no_ack' })
    m.tick()
    expect(m.route()).toBe('direct') // grace period alone does not clear degradation
    m.workerReady()
    expect(m.route()).toBe('room')
  })
})

// ------------------------------------------------------------------ B5: speech routing + fallback
describe('B5 — speech is never blocked by a missing worker', () => {
  it('during a session with no worker, Speak uses direct HTTP TTS with a room-free approval', async () => {
    const room = { speak: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const { c, approvals, direct } = setup({ route: () => 'direct', room })
    expect(await c.request('Hello there', { partnerSpeaking: false })).toBe('spoken')
    expect(room.speak).not.toHaveBeenCalled()
    expect(approvals).toEqual(['direct'])
    expect(direct).toEqual([{ text: 'Hello there', roomName: null }])
    expect(c.lastRoute).toBe('direct')
    expect(c.state.kind).toBe('idle')
  })

  it('worker_not_present on send → same exact text spoken once via HTTP TTS (fresh direct approval)', async () => {
    const room = { speak: vi.fn(async () => { throw new Error('worker_not_present') }), stop: vi.fn(async () => {}) }
    const { c, approvals, direct, fallbacks } = setup({ route: () => 'room', room })
    expect(await c.request('Exact  words ', { partnerSpeaking: false })).toBe('spoken')
    expect(approvals).toEqual(['room', 'direct']) // new signature bound to the direct route
    expect(direct).toEqual([{ text: 'Exact  words ', roomName: null }]) // unchanged text
    expect(fallbacks).toEqual(['worker_not_present'])
    expect(c.state.kind).toBe('idle')
  })

  it('no acknowledgement from the worker → cancels the room attempt, then falls back', async () => {
    const room = { speak: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const { c, direct, fallbacks, deps } = setup({ route: () => 'room', room, ackMs: 15 })
    expect(await c.request('Are you there?', { partnerSpeaking: false })).toBe('pending')
    const roomAttempt = c.activeAttempt!
    expect(direct).toEqual([])
    await wait(40)
    expect(fallbacks).toEqual(['worker_no_ack'])
    expect(room.stop).toHaveBeenCalledTimes(1) // late worker can never also speak it
    expect(direct).toHaveLength(1)
    expect(deps.directStream).toHaveBeenCalledTimes(1)
    // A late status for the abandoned room attempt is ignored.
    c.onWorkerStatus({ type: 'speaking', playbackAttemptId: roomAttempt })
    c.onWorkerStatus({ type: 'done', playbackAttemptId: roomAttempt })
    expect(c.state.kind).toBe('idle')
  })

  it('an acknowledged room delivery never falls back', async () => {
    const room = { speak: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const { c, direct, fallbacks } = setup({ route: () => 'room', room, ackMs: 15 })
    await c.request('Via the worker', { partnerSpeaking: false })
    c.onWorkerStatus({ type: 'speaking', playbackAttemptId: c.activeAttempt! })
    await wait(40)
    expect(fallbacks).toEqual([])
    expect(direct).toEqual([])
    c.onWorkerStatus({ type: 'done', playbackAttemptId: c.activeAttempt! })
    expect(c.state.kind).toBe('idle')
  })

  it('never falls back once audio may have been heard (stays delivery-uncertain)', async () => {
    const room = { speak: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const { c, direct } = setup({ route: () => 'room', room, ackMs: 15 })
    await c.request('Half heard', { partnerSpeaking: false })
    c.onWorkerStatus({ type: 'speaking', playbackAttemptId: c.activeAttempt! })
    c.onWorkerStatus({ type: 'error', reason: 'bad_signature', playbackAttemptId: c.activeAttempt! })
    await wait(30)
    expect(direct).toEqual([])
    expect(c.state.kind).not.toBe('idle')
  })

  it('a worker that cannot verify approvals (bad_signature, nothing heard) falls back', async () => {
    const room = { speak: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const { c, direct, fallbacks } = setup({ route: () => 'room', room })
    await c.request('Secret mismatch', { partnerSpeaking: false })
    c.onWorkerStatus({ type: 'rejected', reason: 'bad_signature', playbackAttemptId: c.activeAttempt! })
    await wait(10)
    expect(fallbacks).toEqual(['worker_bad_signature'])
    expect(direct).toEqual([{ text: 'Secret mismatch', roomName: null }])
  })

  it('a user/budget rejection by the worker is NOT bypassed by the fallback', async () => {
    const room = { speak: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const { c, direct } = setup({ route: () => 'room', room })
    await c.request('Too much', { partnerSpeaking: false })
    c.onWorkerStatus({ type: 'rejected', reason: 'session_char_cap', playbackAttemptId: c.activeAttempt! })
    await wait(10)
    expect(direct).toEqual([])
    expect(c.state.kind).toBe('error')
  })

  it('Stop during the ack window prevents any fallback speech', async () => {
    const room = { speak: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const { c, direct } = setup({ route: () => 'room', room, ackMs: 15 })
    await c.request('Never mind', { partnerSpeaking: false })
    c.stop()
    await wait(40)
    expect(direct).toEqual([])
    expect(c.state.kind).toBe('interrupted')
  })

  it('a held room approval is re-signed for HTTP TTS if the worker left during the hold', async () => {
    let route: Route = 'room'
    const room = { speak: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const { c, approvals, direct } = setup({ route: () => route, room })
    expect(await c.request('After you finish', { partnerSpeaking: true })).toBe('held')
    route = 'direct' // worker disconnected while waiting for the gap
    expect(await c.gap()).toBe('spoken')
    expect(room.speak).not.toHaveBeenCalled()
    expect(approvals).toEqual(['room', 'direct'])
    expect(direct).toEqual([{ text: 'After you finish', roomName: null }])
  })

  it('approval route follows presence: room only once the worker is ready', async () => {
    const m = new WorkerPresenceMonitor()
    const room = { speak: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const { c, approvals } = setup({ route: () => m.route(), room })
    m.connected()
    await c.request('One', { partnerSpeaking: false })
    m.agentJoined()
    m.workerReady()
    await c.request('Two', { partnerSpeaking: false })
    expect(approvals).toEqual(['direct', 'room'])
    expect(room.speak).toHaveBeenCalledTimes(1)
  })
})

// ------------------------------------------------------------------ B6: audio routing
describe('B6 — synthetic voice is never re-captured as partner input', () => {
  it('partner-link: the voice plays ONLY on the partner device, never on the owner device', () => {
    expect(ownerPlaysLocally('partner-link', 'agent')).toBe(false)
    expect(ownerPlaysLocally('partner-link', 'partner')).toBe(false)
    expect(partnerPlaysLocally('agent')).toBe(true)
    expect(partnerPlaysLocally('owner')).toBe(false)
  })

  it('tabletop and remote keep their existing behaviour', () => {
    expect(ownerPlaysLocally('tabletop', 'agent')).toBe(true)
    expect(ownerPlaysLocally('tabletop', 'partner')).toBe(false)
    expect(ownerPlaysLocally('remote', 'agent')).toBe(true)
    expect(ownerPlaysLocally('remote', 'partner')).toBe(true)
  })

  it('network modes use a longer echo tail than tabletop (mirrors worker/revoice_worker/echo.py)', () => {
    expect(echoTailMs('tabletop')).toBe(350)
    expect(echoTailMs('partner-link')).toBe(800)
    expect(echoTailMs('remote')).toBe(800)
  })

  it('fallback playback on the owner device asks the worker to gate partner STT', () => {
    expect(OWNER_FALLBACK_GATES_WORKER).toBe(true)
    expect(ControlMessage.parse({ type: 'gate', on: true, ttlMs: 60_000 })).toMatchObject({ type: 'gate', on: true })
    expect(ControlMessage.parse({ type: 'hello' })).toEqual({ type: 'hello' })
    expect(() => ControlMessage.parse({ type: 'gate', on: true, ttlMs: 10 * 60_000 })).toThrow() // bounded
  })
})
