/**
 * Energy voice-activity detector (pure; the clock is injected so it is unit-tested deterministically).
 *
 * Why it exists: AssemblyAI's `end_of_turn` tells us the partner's TRANSCRIPT ended, but turn-taking also needs to know
 * when the ROOM went quiet (and, more importantly, when the partner starts talking again before the transcript catches up).
 * A tiny RMS detector on the 16 kHz capture frames answers both with ~100 ms latency and costs nothing.
 *
 * Design: adaptive noise floor (tracks the quietest recent level, rises slowly so speech does not raise it), a threshold of
 * `max(minRms, floor × snr)`, a short onset requirement (a click is not a voice) and a hangover (a brief gap between words
 * is not silence). It is deliberately simple — it is a SIGNAL for pause timing, never a gate on what gets transcribed.
 */
export interface VadOptions {
  /** Absolute RMS (0..1 of full scale) below which nothing counts as voice. */
  minRms?: number
  /** Voice must exceed the adaptive noise floor by this factor. */
  snr?: number
  /** Consecutive voiced frames needed before reporting active. */
  onsetFrames?: number
  /** Keep reporting active this long after the last voiced frame. */
  hangoverMs?: number
  /**
   * A run of CONTINUOUS "voice" this long is not speech (speech has gaps between words); it is steady noise such as a fan, a
   * TV or a hum. The noise floor is recalibrated to it so the VAD goes quiet instead of reporting voice forever.
   */
  stuckMs?: number
}

export const VAD_DEFAULTS: Required<VadOptions> = { minRms: 0.012, snr: 3, onsetFrames: 2, hangoverMs: 450, stuckMs: 6000 }
/** The floor never rises above this (a room louder than this is simply not usable for pause detection). */
const FLOOR_MAX = 0.05

export interface VadResult {
  active: boolean
  /** The reported activity flipped on this frame. */
  changed: boolean
  rms: number
}

export function rmsOfInt16(frame: ArrayLike<number>): number {
  const n = frame.length
  if (!n) return 0
  let acc = 0
  for (let i = 0; i < n; i++) {
    const v = frame[i] / 32768
    acc += v * v
  }
  return Math.sqrt(acc / n)
}

export class EnergyVad {
  private o: Required<VadOptions>
  private floor = 0.004
  private voicedRun = 0
  private voicedSince = 0
  private lastVoicedAt = Number.NEGATIVE_INFINITY
  private on = false

  constructor(opts: VadOptions = {}) {
    this.o = { ...VAD_DEFAULTS, ...opts }
  }

  get active() {
    return this.on
  }

  get noiseFloor() {
    return this.floor
  }

  get threshold() {
    return Math.max(this.o.minRms, this.floor * this.o.snr)
  }

  reset() {
    this.floor = 0.004
    this.voicedRun = 0
    this.lastVoicedAt = Number.NEGATIVE_INFINITY
    this.on = false
  }

  /** Feed one PCM frame (any length). */
  push(frame: ArrayLike<number>, now: number): VadResult {
    const rms = rmsOfInt16(frame)
    const voiced = rms > this.threshold
    if (voiced) {
      if (this.voicedRun === 0) this.voicedSince = now
      this.voicedRun += 1
      this.lastVoicedAt = now
      // Stationary "voice" for seconds on end is noise: learn it as the new floor (fast), so the threshold clears it.
      if (now - this.voicedSince >= this.o.stuckMs) this.floor = Math.min(FLOOR_MAX, this.floor + 0.3 * (rms - this.floor))
    } else {
      this.voicedRun = 0
      // Track the floor only on non-voiced frames: quick to fall, slow to rise.
      const a = rms < this.floor ? 0.2 : 0.02
      this.floor = Math.min(FLOOR_MAX, Math.max(0.0005, this.floor + a * (rms - this.floor)))
    }
    const was = this.on
    if (!this.on && this.voicedRun >= this.o.onsetFrames) this.on = true
    else if (this.on && !voiced && now - this.lastVoicedAt >= this.o.hangoverMs) this.on = false
    return { active: this.on, changed: this.on !== was, rms }
  }
}
