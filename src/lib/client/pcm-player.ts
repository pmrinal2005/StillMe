'use client'
/**
 * Streaming raw PCM (s16le mono) player built on Web Audio.
 * - Starts playback on the first chunk (no waiting for the whole clip).
 * - Stop(): silences immediately, clears queued audio, and rejects late chunks from that attempt.
 * - Carries odd bytes across network reads (the network may split samples).
 * Raw PCM is never handed to an <audio> element or mislabelled as MP3.
 */
export class PcmStreamPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private sources = new Set<AudioBufferSourceNode>()
  private nextTime = 0
  private carry: Uint8Array | null = null
  private activeAttempt: string | null = null
  private cancelled = new Set<string>()
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
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2)
    const buf = this.ctx.createBuffer(1, samples.length, sampleRate)
    const ch = buf.getChannelData(0)
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768
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
    if (this.activeAttempt) this.cancelled.add(this.activeAttempt)
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
