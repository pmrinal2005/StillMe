'use client'
/**
 * Listening adapters. Both emit the same events so the UI is transport-agnostic.
 *
 *  LiveKitListener  — primary: partner audio → LiveKit → Python worker → AssemblyAI STT.
 *                     Approved speech is sent to the worker as a signed control message.
 *  DirectSttListener — trusted private demo: browser mic → AssemblyAI streaming STT via a
 *                     short-lived temporary token. Mic is GATED during our own playback so
 *                     synthesized output is never transcribed as partner input.
 */
import { Room, RoomEvent, Track, type RemoteParticipant, type LocalTrackPublication } from 'livekit-client'
import { ControlMessage, DataTopics, RelayFromPartner, RelayToPartner, StatusMessage, TranscriptMessage, type Approval } from '../contracts'
import { isPartnerPeer, RELAY_TURN_STRIDE } from '../relay'
import { ownerPlaysLocally, type ConversationMode } from '../audio-routing'
import { CAPTURE_WORKLET_SRC } from './downsample'
import { EnergyVad, VoiceActivityEmitter } from '../energy-vad'

export interface TurnUpdate { turnId: number; text: string; endOfTurn: boolean; /** C #30: source revision stamped by the worker (absent for browser-direct STT) */ revision?: number }
export interface ListenerEvents {
  onTurn: (t: TurnUpdate) => void
  onSpeechStarted?: () => void
  /**
   * The partner's microphone is carrying voice RIGHT NOW (throttled ~10 Hz). Browser-direct: an energy VAD on the captured
   * PCM (never while our own voice is playing). LiveKit: the worker's speech-started signal (word changes in partial
   * transcripts are picked up by the turn detector itself).
   * Drives the auto turn-taking silence clock.
   */
  onVoiceActivity?: (now: number) => void
  onStatus: (s: { state: 'connecting' | 'listening' | 'paused' | 'reconnecting' | 'closed' | 'error'; detail?: string }) => void
  onWorkerStatus?: (s: ReturnType<typeof StatusMessage.parse>) => void
  onPartnerPresence?: (present: boolean) => void
  /** B5: the voice worker (agent participant) joined or left the room. */
  onAgentPresence?: (present: boolean) => void
  /** F: the owner's room connection came back after a gap — the app must obtain a NEW generation. */
  onReconnected?: () => void
  /** Worker-less captions: the partner's phone reports whether its relay transcription is running. */
  onRelayStatus?: (s: { state: 'listening' | 'closed' | 'error'; detail?: string }) => void
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export class LiveKitListener {
  room: Room | null = null
  private micPub: LocalTrackPublication | undefined
  constructor(private ev: ListenerEvents, private opts: { url: string; token: string; publishMic: boolean; mode: ConversationMode; workerIdentityPrefix?: string }) {}

  get mode() {
    return this.opts.mode
  }

  /** B5: is an agent (voice worker) participant currently in the room? */
  get workerPresent() {
    return this.agentIds().length > 0
  }

  async start() {
    this.ev.onStatus({ state: 'connecting' })
    const room = new Room({ adaptiveStream: true, dynacast: true, audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    this.room = room
    room
      .on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
        // Worker-less captions: relay turns are accepted ONLY while a relay is on and ONLY from a `partner-…` participant
        // (server-signed role attribute). Anything else on this topic is ignored.
        if (topic === DataTopics.relay) {
          if (this.relayEpoch > 0 && this.relayOn && isPartnerPeer(participant) && participant?.identity === this.relayTarget) this.onRelayMessage(payload)
          return
        }
        // Only trust transcript/status from the agent participant.
        if (!participant || !participant.isAgent) return
        try {
          const raw = JSON.parse(dec.decode(payload))
          if (topic === DataTopics.transcript) {
            const m = TranscriptMessage.safeParse(raw)
            if (m.success) {
              if (m.data.speechStarted) {
                this.ev.onVoiceActivity?.(Date.now()) // real voice onset; a (final) transcript arrives AFTER speech ended and is not activity
                this.ev.onSpeechStarted?.()
              } else this.ev.onTurn({ turnId: m.data.turnId, text: m.data.text, endOfTurn: m.data.endOfTurn, revision: m.data.revision })
            }
          } else if (topic === DataTopics.status) {
            const s = StatusMessage.safeParse(raw)
            if (s.success) this.ev.onWorkerStatus?.(s.data)
          }
        } catch {}
      })
      .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        // B6: audio routing policy (src/lib/audio-routing.ts). In partner-link mode the synthetic voice plays
        // ONLY on the partner's phone — playing it here too let the partner's mic capture this speaker and
        // transcribe ReVOICE's own speech as partner input. Partner audio plays only in remote calls.
        if (track.kind === Track.Kind.Audio && ownerPlaysLocally(this.opts.mode, participant.isAgent ? 'agent' : 'partner')) {
          const el = track.attach()
          el.dataset.revoice = 'agent-audio'
          document.body.appendChild(el)
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()))
      .on(RoomEvent.Reconnecting, () => this.ev.onStatus({ state: 'reconnecting' }))
      .on(RoomEvent.Reconnected, () => {
        this.ev.onStatus({ state: 'listening' })
        this.ev.onReconnected?.()
      })
      .on(RoomEvent.Disconnected, () => this.ev.onStatus({ state: 'closed' }))
      .on(RoomEvent.ParticipantConnected, (p) => (p.isAgent ? this.onAgent(true) : this.ev.onPartnerPresence?.(true)))
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        if (p.isAgent) return this.onAgent(false)
        // The partner whose phone was transcribing left: the relay is over (the app restarts it for another partner if needed).
        if (this.relayOn && p.identity === this.relayTarget) {
          this.relayOn = false
          this.relayTarget = null
          this.ev.onRelayStatus?.({ state: 'closed', detail: 'partner_left' })
        }
        this.ev.onPartnerPresence?.(this.hasPartner)
      })
    // B6: in partner-link mode this device never plays room audio, so it does not even subscribe to it
    // (data-channel transcripts/status still arrive). Tabletop/remote subscribe as before.
    await room.connect(this.opts.url, this.opts.token, { autoSubscribe: this.opts.mode !== 'partner-link' })
    // B5: the worker may already be in the room (it is dispatched before we connect).
    if (this.workerPresent) this.onAgent(true)
    if (Array.from(room.remoteParticipants.values()).some((p) => !p.isAgent)) this.ev.onPartnerPresence?.(true)
    if (this.opts.publishMic) {
      this.micPub = await room.localParticipant.setMicrophoneEnabled(true)
    }
    this.ev.onStatus({ state: 'listening' })
  }

  // ---------------------------------------------------------------- worker-less captions (partner-phone relay)
  private relayEpoch = 0
  private relayOn = false
  /** Identity of the ONE partner phone that transcribes (the earliest to join). */
  private relayTarget: string | null = null

  get relayActive() {
    return this.relayOn
  }

  private partnerIds() {
    return this.room ? Array.from(this.room.remoteParticipants.values()).filter((p) => isPartnerPeer(p)).map((p) => p.identity) : []
  }

  private onRelayMessage(payload: Uint8Array) {
    try {
      const m = RelayFromPartner.safeParse(JSON.parse(dec.decode(payload)))
      if (!m.success) return
      if (m.data.type === 'relay_turn') {
        // Each relay stream restarts its turn counter at 0: offset by the epoch so a restarted stream never overwrites older turns.
        this.ev.onTurn({ turnId: this.relayEpoch * RELAY_TURN_STRIDE + m.data.turnId, text: m.data.text, endOfTurn: m.data.endOfTurn })
        if (m.data.text) this.ev.onVoiceActivity?.(Date.now())
      } else this.ev.onRelayStatus?.({ state: m.data.state, detail: m.data.detail })
    } catch {}
  }

  /** Hand the partner's phone a short-lived AssemblyAI streaming URL (addressed to partners only). Returns false if nobody can receive it. */
  async startRelay(wsUrl: string, maxSessionSeconds: number): Promise<boolean> {
    const target = this.earliestPartner()
    if (!target) return false
    this.relayEpoch += 1
    this.relayTarget = target
    this.relayOn = true
    try {
      await this.send(DataTopics.relay, RelayToPartner.parse({ type: 'relay', on: true, wsUrl, maxSessionSeconds }), [target])
    } catch (e) {
      this.relayOn = false
      this.relayTarget = null
      throw e
    }
    return true
  }

  async stopRelay() {
    if (!this.relayOn) return
    const target = this.relayTarget
    this.relayOn = false
    this.relayTarget = null
    if (target) await this.send(DataTopics.relay, { type: 'relay', on: false }, [target]).catch(() => undefined)
  }

  /** Our own voice is playing near the partner: their phone must send silence to STT meanwhile. */
  async relayGate(on: boolean, ttlMs = 60_000) {
    if (this.relayOn && this.relayTarget) await this.send(DataTopics.relay, { type: 'relay_gate', on, ttlMs }, [this.relayTarget]).catch(() => undefined)
  }

  private earliestPartner(): string | null {
    if (!this.room) return null
    const ps = Array.from(this.room.remoteParticipants.values()).filter((p) => isPartnerPeer(p))
    ps.sort((a, b) => Number(a.joinedAt?.getTime?.() ?? 0) - Number(b.joinedAt?.getTime?.() ?? 0))
    return ps[0]?.identity ?? null
  }

  /** A newly joined partner phone gets the running relay (its own short-lived URL is minted by the app, not re-sent here). */
  get hasPartner() {
    return this.partnerIds().length > 0
  }

  private onAgent(joined: boolean) {
    if (!joined && this.workerPresent) return // another agent participant is still here
    this.ev.onAgentPresence?.(joined)
    if (joined) void this.hello()
  }

  /** B5: ask the worker to confirm it is alive (it replies with a `ready` status). */
  async hello() {
    const to = this.agentIds()
    if (to.length) await this.send(DataTopics.control, ControlMessage.parse({ type: 'hello' }), to).catch(() => undefined)
  }

  /** B6: tell the worker to treat partner audio as echo while THIS device plays fallback speech. */
  async gateWorker(on: boolean, ttlMs = 60_000) {
    const to = this.agentIds()
    if (to.length) await this.send(DataTopics.control, ControlMessage.parse({ type: 'gate', on, ttlMs }), to).catch(() => undefined)
  }

  private async send(topic: string, msg: unknown, to?: string[]) {
    if (!this.room) throw new Error('not connected')
    await this.room.localParticipant.publishData(enc.encode(JSON.stringify(msg)), { reliable: true, topic, destinationIdentities: to })
  }

  private agentIds() {
    if (!this.room) return []
    return Array.from(this.room.remoteParticipants.values()).filter((p) => p.isAgent).map((p) => p.identity)
  }

  async speak(approval: Approval, text: string) {
    const msg = ControlMessage.parse({ type: 'speak', approval, text })
    const to = this.agentIds()
    if (!to.length) throw new Error('worker_not_present')
    await this.send(DataTopics.control, msg, to)
  }

  async stop(playbackAttemptId?: string) {
    document.querySelectorAll<HTMLAudioElement>('audio[data-revoice="agent-audio"]').forEach((a) => (a.muted = true))
    setTimeout(() => document.querySelectorAll<HTMLAudioElement>('audio[data-revoice="agent-audio"]').forEach((a) => (a.muted = false)), 400)
    await this.send(DataTopics.control, { type: 'stop', playbackAttemptId }, this.agentIds()).catch(() => undefined)
  }

  /** F: tell the worker the server-issued generation (monotonic; it ignores anything not newer). */
  async sendGeneration(generation: number) {
    const to = this.agentIds()
    if (to.length) await this.send(DataTopics.control, ControlMessage.parse({ type: 'generation', generation }), to).catch(() => undefined)
  }

  /** Push-to-listen / session pause: the worker disconnects its STT stream (stops billing) while paused. */
  async setListening(enabled: boolean) {
    await this.send(DataTopics.control, { type: 'listen', enabled }, this.agentIds())
    this.ev.onStatus({ state: enabled ? 'listening' : 'paused' })
  }

  async presence(composing: boolean, holdTurn = false) {
    const partners = this.room ? Array.from(this.room.remoteParticipants.values()).filter((p) => !p.isAgent).map((p) => p.identity) : []
    if (partners.length) await this.send(DataTopics.presence, { type: 'presence', composing, holdTurn }, partners).catch(() => undefined)
  }

  /** Gate our own mic during playback in tabletop mode (echo safety). */
  async gateMic(gated: boolean) {
    if (this.micPub?.track) gated ? await this.micPub.track.mute() : await this.micPub.track.unmute()
  }

  async close() {
    await this.room?.disconnect()
    this.room = null
    this.ev.onStatus({ state: 'closed' })
  }
}

export class DirectSttListener {
  private ws: WebSocket | null = null
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private gated = false
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private vad: VoiceActivityEmitter
  private ownsStream = true
  constructor(
    private ev: ListenerEvents,
    private getUrl: () => Promise<{ wsUrl: string; maxSessionSeconds: number }>,
    /** Partner relay: reuse the microphone stream LiveKit already publishes instead of opening a second capture (never stopped by us). */
    private opts: { stream?: () => MediaStream | null } = {},
  ) {
    // Energy VAD on the captured 16 kHz PCM → onVoiceActivity (task: auto turn-taking silence clock).
    this.vad = new VoiceActivityEmitter(new EnergyVad(), (now) => this.ev.onVoiceActivity?.(now))
  }

  async start() {
    this.ev.onStatus({ state: 'connecting' })
    this.vad.reset()
    const shared = this.opts.stream?.() ?? null
    this.ownsStream = !shared
    this.stream = shared ?? (await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }))
    this.ctx = new AudioContext()
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SRC], { type: 'application/javascript' }))
    await this.ctx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
    const { wsUrl, maxSessionSeconds } = await this.getUrl()
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(typeof e.data === 'string' ? e.data : dec.decode(e.data))
        if (m.type === 'Begin') this.ev.onStatus({ state: 'listening' })
        else if (m.type === 'SpeechStarted') this.ev.onSpeechStarted?.()
        else if (m.type === 'Turn') this.ev.onTurn({ turnId: m.turn_order, text: m.transcript ?? '', endOfTurn: !!m.end_of_turn })
        else if (m.type === 'Termination') this.ev.onStatus({ state: 'closed' })
        else if (m.error) this.ev.onStatus({ state: 'error', detail: String(m.error) })
      } catch {}
    }
    ws.onclose = (e) => {
      this.cleanupAudio()
      // 1000 = normal end (Terminate / session ended). Any other code (3005 expired, 1008 policy, 4xxx provider refusal, 1011 server
      // error) is reported so the owner is told WHY listening stopped instead of seeing a silent drop.
      const normal = e.code === 1000 || e.code === 1005
      this.ev.onStatus(normal ? { state: 'closed' } : { state: 'closed', detail: `stt_closed_${e.code}${e.reason ? `_${String(e.reason).slice(0, 40)}` : ''}` })
    }
    ws.onerror = () => this.ev.onStatus({ state: 'error', detail: 'stt_socket_error' })
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true })
      ws.addEventListener('error', () => rej(new Error('stt_connect_failed')), { once: true })
    })
    const src = this.ctx.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(this.ctx, 'rv-capture')
    this.node.port.onmessage = (e) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      const buf = e.data as ArrayBuffer
      // Voice activity is measured on what the PARTNER mic carried — never while gated (our own voice is playing).
      try { this.vad.frame(new Int16Array(buf.slice(0)), performance.now() + performance.timeOrigin, this.gated) } catch {}
      // While gated, send silence (keeps timing) — note: billing continues while connected.
      if (this.gated) this.ws.send(new Int16Array(buf.byteLength / 2).buffer)
      else this.ws.send(buf)
    }
    src.connect(this.node)
    // Client-side watchdog: terminate before the server cap to avoid billed overrun.
    this.watchdog = setTimeout(() => this.close(), Math.max(30, maxSessionSeconds - 15) * 1000)
  }

  gateMic(gated: boolean) {
    this.gated = gated
  }

  private cleanupAudio() {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.node?.disconnect()
    if (this.ownsStream) this.stream?.getTracks().forEach((t) => t.stop()) // a shared (LiveKit) mic stream is never ours to stop
    this.ctx?.close().catch(() => undefined)
    this.node = null
    this.stream = null
    this.ctx = null
  }

  /** Disconnecting (not just muting) is what stops session-duration billing. */
  async close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'Terminate' })) } catch {}
      setTimeout(() => this.ws?.close(), 1500)
    }
    this.cleanupAudio()
  }
}
