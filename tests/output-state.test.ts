import { describe, expect, it } from 'vitest'
import { partnerIsSpeaking, reduceOutput, type OutputEvent, type OutputState } from '@/lib/output-state'

const run = (events: OutputEvent[], s: OutputState = { kind: 'idle' }) => events.reduce(reduceOutput, s)

describe('output state machine', () => {
  it('happy path: review → speaking → idle', () => {
    expect(run([{ type: 'edit', text: 'hi' }, { type: 'approved', text: 'hi', approvalId: 'a', partnerSpeaking: false, now: 0 }, { type: 'started', attemptId: 'p' }, { type: 'first_audio' }, { type: 'finished' }])).toEqual({ kind: 'idle' })
  })
  it('holds for a gap while the partner speaks; speak_now overrides', () => {
    const held = run([{ type: 'approved', text: 'hi', approvalId: 'a', partnerSpeaking: true, now: 5 }])
    expect(held.kind).toBe('approved_pending_gap')
    expect(reduceOutput(held, { type: 'gap' }).kind).toBe('speaking')
    expect(reduceOutput(held, { type: 'speak_now' }).kind).toBe('speaking')
  })
  it('material context change cancels a held approval back to review (renewed approval required)', () => {
    const held = run([{ type: 'approved', text: 'yes', approvalId: 'a', partnerSpeaking: true, now: 0 }])
    expect(reduceOutput(held, { type: 'context_changed', reason: 'negation' })).toEqual({ kind: 'review', text: 'yes' })
  })
  it('stop → interrupted, never resumes on later events', () => {
    let s = run([{ type: 'approved', text: 'x', approvalId: 'a', partnerSpeaking: false, now: 0 }, { type: 'first_audio' }, { type: 'stop' }])
    expect(s.kind).toBe('interrupted')
    for (const e of [{ type: 'gap' }, { type: 'first_audio' }, { type: 'finished' }, { type: 'speak_now' }] as OutputEvent[]) s = reduceOutput(s, e)
    expect(s.kind).toBe('interrupted')
  })
  it('network failure after audio → delivery_uncertain; before audio → error', () => {
    const speaking = run([{ type: 'approved', text: 'x', approvalId: 'a', partnerSpeaking: false, now: 0 }])
    expect(reduceOutput(reduceOutput(speaking, { type: 'first_audio' }), { type: 'network_failed', reason: 'drop' }).kind).toBe('delivery_uncertain')
    expect(reduceOutput(speaking, { type: 'network_failed', reason: 'drop' }).kind).toBe('error')
  })
  it('one utterance at a time: approval while speaking is ignored; edits do not affect in-flight speech', () => {
    const speaking = run([{ type: 'approved', text: 'x', approvalId: 'a', partnerSpeaking: false, now: 0 }])
    expect(reduceOutput(speaking, { type: 'approved', text: 'y', approvalId: 'b', partnerSpeaking: false, now: 1 })).toBe(speaking)
    expect(reduceOutput(speaking, { type: 'edit', text: 'z' })).toBe(speaking)
  })
  it('budget pauses output', () => {
    expect(reduceOutput({ kind: 'idle' }, { type: 'budget', reason: 'tts_daily_chars' }).kind).toBe('paused_for_budget')
  })
  it('there is no event path into speaking without an approved event', () => {
    const nonApproval: OutputEvent[] = [{ type: 'edit', text: 'x' }, { type: 'gap' }, { type: 'speak_now' }, { type: 'started', attemptId: 'p' }, { type: 'first_audio' }, { type: 'finished' }, { type: 'context_changed', reason: 'r' }, { type: 'reset' }]
    const states: OutputState[] = [{ kind: 'idle' }, { kind: 'review', text: 'x' }, { kind: 'interrupted', text: 'x' }, { kind: 'delivery_uncertain', text: 'x', reason: 'r' }, { kind: 'error', message: 'm' }]
    for (const s of states) for (const e of nonApproval) expect(reduceOutput(s, e).kind).not.toBe('speaking')
  })
  it('partnerIsSpeaking window', () => {
    expect(partnerIsSpeaking(undefined, 0)).toBe(false)
    expect(partnerIsSpeaking({ endOfTurn: false, updatedAt: 1000 }, 2000)).toBe(true)
    expect(partnerIsSpeaking({ endOfTurn: false, updatedAt: 0 }, 5000)).toBe(false)
    expect(partnerIsSpeaking({ endOfTurn: true, updatedAt: 1000 }, 1100)).toBe(false)
  })
})
