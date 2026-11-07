/**
 * Energy-based voice-activity detector (pure, DOM-free, unit-tested).
 *
 * Feeds the auto turn-taking silence clock: "is the partner's microphone carrying voice RIGHT NOW?". It complements the STT
 * transcript (which lags speech by ~1 s) so the silence timer starts from the real end of speech, not from the transcript.
 *
 *  - frame energy = RMS of 16-bit PCM, normalised to 0..1
 *  - adaptive noise floor (falls fast, rises slowly, frozen while voice is active) so a fan or a noisy room is not "speech"
 *  - hysteresis (separate on/off thresholds) + a short hangover so word gaps do not look like silence
 *  - onset needs ONSET_FRAMES consecutive loud frames so a click or a cough tick is not speech
 * It is a heuristic: it cannot tell the partner from music or a TV. Transcripts still decide WHAT was said; this only decides WHEN.
 */
export interface EnergyVadOptions {
  /** Absolute floor for the "voice on" threshold (RMS 0..1). */
  minOn?: number
  /** Absolute floor for the "voice off" threshold. */
  minOff?: number
  /** Voice-on threshold = noiseFloor × this. */
  onRatio?: number
  offRatio?: number
  /** Keep reporting voice this long after the last loud frame. */
  hangoverMs?: number
  /** Consecutive loud frames needed before speech starts. */
  onsetFrames?: number
}

export type VadEvent = 'start' | 'end' | null

export interface VadFrameResult {
  /** Voice currently considered present (includes the hangover). */
  active: boolean
  rms: number
  /** 'start' on the first active frame of an utterance, 'end' on the first inactive frame after it. */
  event: VadEvent
  noiseFloor: number
}

export const VAD_DEFAULTS = { minOn: 0.018, minOff: 0.011, onRatio: 3, offRatio: 2, hangoverMs: 350, onsetFrames: 2 } as const

/** RMS of an Int16 PCM frame, normalised to 0..1. Empty frame = 0. */
export function rmsInt16(frame: Int16Array): number {
  const n = frame.length
  if (!n) return 0
  let acc = 0
  for (let i = 0; i < n; i++) {
    const s = frame[i] / 32768
    acc += s * s
  }
  return Math.sqrt(acc / n)
}

export class EnergyVad {
  private o: Required<EnergyVadOptions>
  private floor = 0.004
  private active = false
  private loud = 0
  private lastLoudAt = Number.NEGATIVE_INFINITY
  private seeded = false

  constructor(opts: EnergyVadOptions = {}) {
    this.o = { ...VAD_DEFAULTS, ...opts }
  }

  get noiseFloor() {
    return this.floor
  }
  get isActive() {
    return this.active
  }

  reset() {
    this.floor = 0.004
    this.active = false
    this.loud = 0
    this.lastLoudAt = Number.NEGATIVE_INFINITY
    this.seeded = false
  }

  /** Process one frame (any length ≥ 1 sample) captured at `now` (ms, monotonic). */
  process(frame: Int16Array, now: number): VadFrameResult {
    return this.processRms(rmsInt16(frame), now)
  }

  processRms(rms: number, now: number): VadFrameResult {
    if (!this.seeded) {
      // The first frame calibrates the floor (assumes the owner starts listening before the partner speaks).
      this.floor = Math.min(0.05, Math.max(0.001, rms))
      this.seeded = true
    }
    const on = Math.max(this.o.minOn, this.floor * this.o.onRatio)
    const off = Math.max(this.o.minOff, this.floor * this.o.offRatio)
    const wasActive = this.active

    if (!this.active) {
      if (rms >= on) this.loud += 1
      else this.loud = 0
      if (this.loud >= this.o.onsetFrames) {
        this.active = true
        this.lastLoudAt = now
      }
    } else {
      if (rms >= off) this.lastLoudAt = now
      if (now - this.lastLoudAt > this.o.hangoverMs) {
        this.active = false
        this.loud = 0
      }
    }

    // Noise floor: only learn from frames that are NOT voice. Falls quickly, rises slowly, capped so loud rooms cannot mask speech forever.
    if (!this.active && rms < on) {
      this.floor = rms < this.floor ? this.floor * 0.5 + rms * 0.5 : this.floor * 0.98 + rms * 0.02
      this.floor = Math.min(0.05, Math.max(0.0005, this.floor))
    }

    return { active: this.active, rms, event: this.active && !wasActive ? 'start' : !this.active && wasActive ? 'end' : null, noiseFloor: this.floor }
  }
}

/** Minimum gap between onVoiceActivity callbacks (the silence clock only needs ~10 Hz). */
export const VOICE_ACTIVITY_THROTTLE_MS = 100

/** Wraps an EnergyVad and calls `onVoiceActivity(now)` (throttled) for every voiced frame. Gated frames are ignored. */
export class VoiceActivityEmitter {
  private lastEmit = Number.NEGATIVE_INFINITY
  constructor(private vad: EnergyVad, private onVoiceActivity: (now: number) => void, private throttleMs = VOICE_ACTIVITY_THROTTLE_MS) {}

  frame(pcm: Int16Array, now: number, gated: boolean): VadFrameResult | null {
    if (gated) return null // we are sending silence while our own voice plays: nothing heard counts
    const r = this.vad.process(pcm, now)
    if (r.active && now - this.lastEmit >= this.throttleMs) {
      this.lastEmit = now
      this.onVoiceActivity(now)
    }
    return r
  }

  reset() {
    this.vad.reset()
    this.lastEmit = Number.NEGATIVE_INFINITY
  }
}
