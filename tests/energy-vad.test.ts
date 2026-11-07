import { describe, expect, it } from 'vitest'
import { EnergyVad, VOICE_ACTIVITY_THROTTLE_MS, VoiceActivityEmitter, rmsInt16 } from '@/lib/energy-vad'

/** A 50 ms frame at 16 kHz with a sine of the given amplitude (0..1). */
function tone(amp: number, n = 800, hz = 220): Int16Array {
  const a = new Int16Array(n)
  for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / 16000) * amp * 32767)
  return a
}
const hiss = (amp: number, n = 800): Int16Array => {
  const a = new Int16Array(n)
  let x = 12345
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    a[i] = Math.round(((x / 0x7fffffff) * 2 - 1) * amp * 32767)
  }
  return a
}

describe('rmsInt16', () => {
  it('is 0 for silence/empty and ~amp/√2 for a sine', () => {
    expect(rmsInt16(new Int16Array(0))).toBe(0)
    expect(rmsInt16(new Int16Array(800))).toBe(0)
    expect(rmsInt16(tone(0.5))).toBeCloseTo(0.5 / Math.SQRT2, 2)
  })
})

describe('EnergyVad', () => {
  it('stays inactive on a quiet room and calibrates its noise floor', () => {
    const v = new EnergyVad()
    let t = 0
    for (let i = 0; i < 40; i++) {
      expect(v.process(hiss(0.004), t).active).toBe(false)
      t += 50
    }
    expect(v.noiseFloor).toBeLessThan(0.01)
  })

  it('detects speech after the onset frames, reports start once, and ends after the hangover', () => {
    const v = new EnergyVad()
    let t = 0
    for (let i = 0; i < 10; i++, t += 50) v.process(hiss(0.003), t)
    const events: string[] = []
    // a single loud frame is NOT speech (click / cough tick)
    expect(v.process(tone(0.3), t).active).toBe(false)
    t += 50
    v.process(hiss(0.003), t)
    t += 50
    // sustained voice
    const r1 = v.process(tone(0.3), t)
    t += 50
    const r2 = v.process(tone(0.3), t)
    t += 50
    for (const r of [r1, r2]) if (r.event) events.push(r.event)
    expect(r2.active).toBe(true)
    expect(events).toEqual(['start'])
    // brief word gap shorter than the hangover is still active
    t += 50
    expect(v.process(hiss(0.003), t).active).toBe(true)
    // long silence ends it, exactly once
    let ends = 0
    for (let i = 0; i < 20; i++, t += 50) if (v.process(hiss(0.003), t).event === 'end') ends++
    expect(ends).toBe(1)
    expect(v.isActive).toBe(false)
  })

  it('adapts to a steadily noisy room instead of treating it as speech', () => {
    const v = new EnergyVad()
    let t = 0
    let falsePositives = 0
    for (let i = 0; i < 80; i++, t += 50) if (v.process(hiss(0.03), t).active) falsePositives++
    expect(falsePositives).toBe(0)
    // …and speech above that noise is still heard
    let heard = false
    for (let i = 0; i < 6; i++, t += 50) if (v.process(tone(0.5), t).active) heard = true
    expect(heard).toBe(true)
  })

  it('freezes the noise floor while voice is active (speech does not raise the floor)', () => {
    const v = new EnergyVad()
    let t = 0
    for (let i = 0; i < 20; i++, t += 50) v.process(hiss(0.003), t)
    const floor = v.noiseFloor
    for (let i = 0; i < 40; i++, t += 50) v.process(tone(0.4), t)
    expect(v.noiseFloor).toBeCloseTo(floor, 3)
  })

  it('reset() forgets everything', () => {
    const v = new EnergyVad()
    for (let i = 0; i < 6; i++) v.process(tone(0.4), i * 50)
    expect(v.isActive).toBe(true)
    v.reset()
    expect(v.isActive).toBe(false)
  })
})

describe('VoiceActivityEmitter', () => {
  it('emits onVoiceActivity (throttled) only for voiced, un-gated frames', () => {
    const calls: number[] = []
    const e = new VoiceActivityEmitter(new EnergyVad(), (n) => calls.push(n))
    let t = 0
    for (let i = 0; i < 10; i++, t += 50) e.frame(hiss(0.003), t, false)
    expect(calls).toEqual([])
    for (let i = 0; i < 12; i++, t += 50) e.frame(tone(0.4), t, false)
    expect(calls.length).toBeGreaterThan(2)
    for (let i = 1; i < calls.length; i++) expect(calls[i] - calls[i - 1]).toBeGreaterThanOrEqual(VOICE_ACTIVITY_THROTTLE_MS)
  })
  it('ignores frames while gated (our own voice is playing)', () => {
    const calls: number[] = []
    const e = new VoiceActivityEmitter(new EnergyVad(), (n) => calls.push(n))
    for (let i = 0; i < 30; i++) expect(e.frame(tone(0.5), i * 50, true)).toBeNull()
    expect(calls).toEqual([])
  })
})
