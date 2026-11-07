import { describe, expect, it } from 'vitest'
import { EnergyVad, rmsOfInt16 } from '@/lib/vad'

const frame = (amp: number, n = 800) => Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 3) * amp * 32767))

describe('rmsOfInt16', () => {
  it('is 0 for silence/empty and ~0.707×amp for a sine', () => {
    expect(rmsOfInt16(new Int16Array(0))).toBe(0)
    expect(rmsOfInt16(new Int16Array(100))).toBe(0)
    expect(rmsOfInt16(frame(0.5, 16000))).toBeCloseTo(0.354, 2)
  })
})

describe('EnergyVad', () => {
  it('stays off in quiet, turns on after the onset frames of speech, off after the hangover', () => {
    const v = new EnergyVad()
    let t = 0
    for (let i = 0; i < 20; i++, t += 50) expect(v.push(frame(0.002), t).active).toBe(false)
    expect(v.push(frame(0.2), (t += 50)).active).toBe(false) // one frame is not yet a voice
    const on = v.push(frame(0.2), (t += 50))
    expect(on).toMatchObject({ active: true, changed: true })
    // brief dip shorter than the hangover keeps it on
    expect(v.push(frame(0.002), (t += 50)).active).toBe(true)
    expect(v.push(frame(0.2), (t += 50)).active).toBe(true)
    let off = false
    for (let i = 0; i < 12; i++) if (v.push(frame(0.002), (t += 50)).changed) off = true
    expect(off).toBe(true)
    expect(v.active).toBe(false)
  })
  it('a single click is not a voice', () => {
    const v = new EnergyVad()
    v.push(frame(0.002), 0)
    expect(v.push(frame(0.5, 40), 50).active).toBe(false)
    expect(v.push(frame(0.002), 100).active).toBe(false)
  })
  it('adapts to a noisy room: steady hum does not count as voice, louder speech does', () => {
    const v = new EnergyVad()
    let t = 0
    // 0.02 amplitude (RMS ~0.014) is above the minimum threshold, so it first reads as voice...
    for (let i = 0; i < 20; i++, t += 50) v.push(frame(0.02), t)
    expect(v.active).toBe(true)
    // ...but after the stuck-run limit it is learned as the room's noise floor and the VAD goes quiet.
    for (let i = 0; i < 200; i++, t += 50) v.push(frame(0.02), t)
    expect(v.active).toBe(false)
    expect(v.noiseFloor).toBeGreaterThan(0.005)
    // Real speech, louder than the hum, is still detected afterwards.
    v.push(frame(0.4), (t += 50))
    expect(v.push(frame(0.4), (t += 50)).active).toBe(true)
  })
  it('continuous loud speech shorter than the stuck limit does not drag the floor', () => {
    const v = new EnergyVad()
    let t = 0
    for (let i = 0; i < 10; i++, t += 50) v.push(frame(0.002), t)
    const floor = v.noiseFloor
    for (let i = 0; i < 100; i++, t += 50) v.push(frame(0.3), t) // 5 s < 6 s stuck limit
    expect(v.noiseFloor).toBeCloseTo(floor, 3)
  })
  it('reset clears state', () => {
    const v = new EnergyVad()
    v.push(frame(0.4), 0)
    v.push(frame(0.4), 50)
    v.reset()
    expect(v.active).toBe(false)
  })
})
