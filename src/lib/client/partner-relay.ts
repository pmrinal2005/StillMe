'use client'
/**
 * Partner-phone relay STT ("worker-less captions").
 *
 * When no voice worker is transcribing a partner-link / remote session, the owner's device mints a short-lived AssemblyAI
 * streaming URL (counted in the owner's listening-minute ledger) and sends it ONLY to the partner's phone. This class runs on
 * the PARTNER's phone: it transcribes the partner's own microphone (the track LiveKit already publishes — no second capture)
 * and relays turn text back to the owner over the data channel. It never records or stores audio or text.
 */
import { CAPTURE_WORKLET_SRC } from './downsample'
import { RelayFromPartner } from '../contracts'

export interface PartnerRelayOptions {
  wsUrl: string
  maxSessionSeconds: number
  getStream: () => MediaStream | null
  send: (msg: ReturnType<typeof RelayFromPartner.parse>) => void
}

export class PartnerRelayStt {
  private ws: WebSocket | null = null
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private src: MediaStreamAudioSourceNode | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private gated = false
  private gateTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  constructor(private o: PartnerRelayOptions) {}

  async start() {
    const stream = this.o.getStream()
    if (!stream) throw new Error('no_microphone_stream')
    this.ctx = new AudioContext() // the capture worklet downsamples from whatever rate the context runs at
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SRC], { type: 'application/javascript' }))
    await this.ctx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
    const ws = new WebSocket(this.o.wsUrl)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data))
        if (m.type === 'Begin') this.o.send({ type: 'relay_status', state: 'listening' })
        else if (m.type === 'Turn') this.o.send({ type: 'relay_turn', turnId: Math.max(0, Math.min(9999, Number(m.turn_order) || 0)), text: String(m.transcript ?? '').slice(0, 4000), endOfTurn: !!m.end_of_turn })
        else if (m.type === 'Termination') this.o.send({ type: 'relay_status', state: 'closed' })
      } catch {}
    }
    ws.onclose = (e) => {
      this.cleanup()
      if (!this.stopped) this.o.send({ type: 'relay_status', state: 'closed', detail: e.code === 1000 || e.code === 1005 ? undefined : `stt_closed_${e.code}` })
    }
    ws.onerror = () => this.o.send({ type: 'relay_status', state: 'error', detail: 'stt_socket_error' })
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true })
      ws.addEventListener('error', () => rej(new Error('stt_connect_failed')), { once: true })
    })
    this.src = this.ctx.createMediaStreamSource(stream)
    this.node = new AudioWorkletNode(this.ctx, 'rv-capture')
    this.node.port.onmessage = (e) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      const buf = e.data as ArrayBuffer
      // While the owner's synthetic voice plays near this phone, send silence (keeps timing; never transcribes our own voice).
      this.ws.send(this.gated ? new Int16Array(buf.byteLength / 2).buffer : buf)
    }
    this.src.connect(this.node)
    // Stop before the server cap so the owner is never billed past the reservation.
    this.watchdog = setTimeout(() => void this.stop(), Math.max(30, this.o.maxSessionSeconds - 10) * 1000)
  }

  gate(on: boolean, ttlMs = 60_000) {
    this.gated = on
    if (this.gateTimer) clearTimeout(this.gateTimer)
    if (on) this.gateTimer = setTimeout(() => (this.gated = false), Math.min(ttlMs, 120_000)) // a lost "off" can never mute the partner for good
  }

  private cleanup() {
    if (this.watchdog) clearTimeout(this.watchdog)
    if (this.gateTimer) clearTimeout(this.gateTimer)
    this.src?.disconnect()
    this.node?.disconnect()
    this.ctx?.close().catch(() => undefined)
    this.src = this.node = this.ctx = null // the shared LiveKit mic stream is never stopped here
  }

  /** Disconnecting (not muting) is what stops session-duration billing. */
  async stop() {
    this.stopped = true
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'Terminate' })) } catch {}
      const w = this.ws
      setTimeout(() => { try { w.close() } catch {} }, 1500)
    }
    this.cleanup()
  }
}
