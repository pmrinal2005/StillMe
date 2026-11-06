'use client'
/**
 * Streaming raw PCM (s16le mono) player built on Web Audio.
 * - Starts playback on the first chunk (no waiting for the whole clip).
 * - Stop(): silences immediately, clears queued audio, and rejects late chunks from that attempt.
 * - Carries odd bytes across network reads (the network may split samples).
 * - D #43: samples are decoded with a DataView, so a chunk that starts at an ODD byte offset (a network read slice, a
 *   subarray) can no longer make `new Int16Array(buffer, byteOffset, ...)` throw a RangeError and kill playback.
 * - D #43: the list of cancelled attempts is bounded (it used to grow for the life of the page).
 * Raw PCM is never handed to an <audio> element or mislabelled as MP3.
 */
/**
 * Decode little-endian signed 16-bit PCM into floats in [-1, 1). Alignment-safe: reads through a DataView with the
 * chunk's own byteOffset, so ANY start offset works (an Int16Array view needs an even byteOffset and throws otherwise).
 */
export function decodePcm16le(bytes: Uint8Array, out: Float32Array): number {
  const n = Math.min(Math.floor(bytes.length / 2), out.length)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768
  return n
}

/** Keep a Set's most recently inserted `max` entries (Sets iterate in insertion order). */
export function trimOldest<T>(set: Set<T>, max: number): void {
  while (set.size > max) {
    const first = set.values().next()
    if (first.done) return
    set.delete(first.value)
  }
}

export class PcmStreamPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private sources = new Set<AudioBufferSourceNode>()
  private nextTime = 0
  private carry: Uint8Array | null = null
  private activeAttempt: string | null = null
  private cancelled = new Set<string>()
  /** D #43: only the most recent cancelled attempts matter (late frames arrive within seconds). */
  static readonly MAX_CANCELLED = 32
  public onFirstAudio?: (attemptId: string, atMs: number) => void
  private firstFired = false

  /** Must be called from a user gesture at least once (iOS/Safari audio unlock). */
  async unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new Ctx({ latencyHint: 'interactive' })
      this.gain = this.ctx.createGain()
      this.gain.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  begin(attemptId: string) {
    this.stop()
    this.activeAttempt = attemptId
    this.firstFired = false
    this.carry = null
    if (this.gain && this.ctx) this.gain.gain.setValueAtTime(1, this.ctx.currentTime)
    this.nextTime = 0
  }

  push(attemptId: string, chunk: Uint8Array, sampleRate: number) {
    if (!this.ctx || !this.gain) return
    if (attemptId !== this.activeAttempt || this.cancelled.has(attemptId)) return // late frame from a cancelled generation
    let bytes = chunk
    if (this.carry) {
      const merged = new Uint8Array(this.carry.length + chunk.length)
      merged.set(this.carry)
      merged.set(chunk, this.carry.length)
      bytes = merged
      this.carry = null
    }
    if (bytes.length % 2 === 1) {
      this.carry = bytes.slice(bytes.length - 1)
      bytes = bytes.slice(0, bytes.length - 1)
    }
    if (bytes.length === 0) return
    const n = bytes.length / 2
    const buf = this.ctx.createBuffer(1, n, sampleRate)
    const ch = buf.getChannelData(0)
    decodePcm16le(bytes, ch)
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.gain)
    const now = this.ctx.currentTime
    if (this.nextTime < now + 0.02) this.nextTime = now + 0.02
    src.start(this.nextTime)
    this.nextTime += buf.duration
    this.sources.add(src)
    src.onended = () => this.sources.delete(src)
    if (!this.firstFired) {
      this.firstFired = true
      this.onFirstAudio?.(attemptId, performance.now())
    }
  }

  /** Resolves when all scheduled audio has played (or immediately if stopped). */
  async drained(): Promise<void> {
    if (!this.ctx) return
    const wait = Math.max(0, this.nextTime - this.ctx.currentTime)
    await new Promise((r) => setTimeout(r, wait * 1000 + 30))
  }

  stop() {
    if (this.activeAttempt) {
      this.cancelled.add(this.activeAttempt)
      trimOldest(this.cancelled, PcmStreamPlayer.MAX_CANCELLED)
    }
    if (this.gain && this.ctx) this.gain.gain.setValueAtTime(0, this.ctx.currentTime)
    for (const s of this.sources) {
      try { s.stop() } catch {}
      s.disconnect()
    }
    this.sources.clear()
    this.nextTime = 0
    this.carry = null
    this.activeAttempt = null
  }

  get isPlaying() {
    return !!this.ctx && this.sources.size > 0
  }
}
