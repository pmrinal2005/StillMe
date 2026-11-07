'use client'
/**
 * Partner-link mode. The partner joins via an expiring signed invite (in the URL fragment, so it
 * is never sent to servers in Referer headers or access logs), explicitly acknowledges that their
 * speech will be transcribed, and publishes ONLY a microphone track.
 *
 * Partner coaching view: shows when the ReVOICE user is composing (never the draft content) and
 * encourages patience. Approved synthetic speech from the worker plays here — and, in partner-link
 * mode, ONLY here (B6).
 */
import { useEffect, useRef, useState } from 'react'
import { Room, RoomEvent, Track, type RemoteParticipant } from 'livekit-client'
import { DataTopics, PresenceMessage, RelayToPartner } from '@/lib/contracts'
import { partnerPlaysLocally } from '@/lib/audio-routing'
import { clearStoredClaim, formatRemaining, inviteInfo, parseInviteFromHash, readStoredClaim, writeStoredClaim, type InviteInfo } from '@/lib/invite-link'
import { mapJoinError } from '@/lib/join-errors'
import { isAssemblyStreamingUrl, isOwnerPeer } from '@/lib/relay'
import { PartnerRelayStt } from '@/lib/client/partner-relay'
import { Icon } from '@/components/ui/Icon'
import { Backdrop, Logo, Orb, type OrbState } from '@/components/ui/Orb'

type Phase = 'consent' | 'joining' | 'joined' | 'ended' | 'error'
const dec = new TextDecoder()

export default function JoinPage() {
  const [invite, setInvite] = useState('')
  const [label, setLabel] = useState('')
  const [consent, setConsent] = useState(false)
  const [phase, setPhase] = useState<Phase>('consent')
  const [error, setError] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [holdTurn, setHoldTurn] = useState(false)
  const [voiceSpeaking, setVoiceSpeaking] = useState(false)
  const [muted, setMuted] = useState(false)
  const [fatal, setFatal] = useState(false)
  const [rejoinable, setRejoinable] = useState(false)
  const [info, setInfo] = useState<InviteInfo>({ state: 'missing' })
  const [now, setNow] = useState(() => Date.now())
  const [relayState, setRelayState] = useState<'off' | 'on'>('off')
  const roomRef = useRef<Room | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const relayRef = useRef<PartnerRelayStt | null>(null)
  const leftOnPurpose = useRef(false)

  useEffect(() => {
    // Never throws: a link cut by a chat app (`%E0%A4%A`) used to blank the page.
    const raw = parseInviteFromHash(window.location.hash)
    setInvite(raw)
    setInfo(inviteInfo(raw))
    // Same phone, page reloaded / network changed: a stored claim lets the partner rejoin WITHOUT a second invite.
    const stored = readStoredClaim(typeof sessionStorage !== 'undefined' ? sessionStorage : undefined)
    if (stored) {
      setRejoinable(true)
      if (stored.label) setLabel(stored.label)
    }
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(t)
      void relayRef.current?.stop()
      void roomRef.current?.disconnect()
    }
  }, [])

  const join = async (useClaim = false) => {
    setError(null)
    setFatal(false)
    setPhase('joining')
    try {
      const stored = useClaim ? readStoredClaim(typeof sessionStorage !== 'undefined' ? sessionStorage : undefined) : null
      let res: Response
      try {
        res = await fetch('/api/livekit/join', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(stored ? { claim: stored.claim, label: label.trim() || stored.label || 'Partner', consent: true } : { invite, label: label.trim() || 'Partner', consent: true }),
        })
      } catch {
        throw Object.assign(new Error('network'), { status: 0 })
      }
      const body = await res.json().catch(() => ({}) as Record<string, unknown>)
      if (!res.ok) throw Object.assign(new Error(String(body.error ?? `http_${res.status}`)), { status: res.status })
      if (typeof body.claim === 'string' && typeof body.room === 'string') {
        writeStoredClaim(typeof sessionStorage !== 'undefined' ? sessionStorage : undefined, { claim: body.claim, room: body.room, label: label.trim() || 'Partner', at: Date.now() })
      }
      leftOnPurpose.current = false
      const room = new Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      roomRef.current = room
      room
        .on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant, _k?: unknown, topic?: string) => {
          // Worker-less captions: only the room's OWNER (server-signed role attribute) may start/stop the relay on this phone.
          if (topic === DataTopics.relay) {
            if (!isOwnerPeer(participant)) return
            try {
              const m = RelayToPartner.safeParse(JSON.parse(dec.decode(payload)))
              if (!m.success) return
              if (m.data.type === 'relay' && m.data.on) {
                if (!isAssemblyStreamingUrl(m.data.wsUrl)) return // never point this microphone anywhere but AssemblyAI streaming
                void relayRef.current?.stop()
                const r = new PartnerRelayStt({
                  wsUrl: m.data.wsUrl,
                  maxSessionSeconds: m.data.maxSessionSeconds,
                  getStream: () => {
                    const t = roomRef.current?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
                    return t?.mediaStreamTrack ? new MediaStream([t.mediaStreamTrack]) : null
                  },
                  send: (msg) => void roomRef.current?.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(msg)), { reliable: true, topic: DataTopics.relay, destinationIdentities: [participant!.identity] }).catch(() => undefined),
                })
                relayRef.current = r
                setRelayState('on')
                void r.start().catch(() => setRelayState('off'))
              } else if (m.data.type === 'relay' && !m.data.on) {
                void relayRef.current?.stop()
                relayRef.current = null
                setRelayState('off')
              } else if (m.data.type === 'relay_gate') relayRef.current?.gate(m.data.on, m.data.ttlMs)
            } catch {}
            return
          }
          if (topic !== DataTopics.presence || !isOwnerPeer(participant)) return // partners can publish data now (relay): only the owner's presence counts
          try {
            const m = PresenceMessage.safeParse(JSON.parse(dec.decode(payload)))
            if (!m.success) return
            setComposing(m.data.composing)
            if (m.data.holdTurn) {
              setHoldTurn(true)
              if (holdTimer.current) clearTimeout(holdTimer.current)
              holdTimer.current = setTimeout(() => setHoldTurn(false), 20_000)
            }
          } catch {}
        })
        .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
          // B6: this phone is the ONLY place the synthetic voice plays in partner-link mode (the owner device
          // no longer plays it, so this microphone never re-captures a second loudspeaker). Its own echo
          // canceller removes this device's playback; the worker also gates STT while it speaks.
          if (track.kind === Track.Kind.Audio && partnerPlaysLocally(participant.isAgent ? 'agent' : 'owner')) {
            const el = track.attach()
            el.dataset.revoice = 'voice'
            document.body.appendChild(el)
          }
        })
        .on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()))
        .on(RoomEvent.ParticipantDisconnected, (p) => {
          if (isOwnerPeer(p)) {
            void relayRef.current?.stop()
            relayRef.current = null
            setRelayState('off')
          }
        })
        .on(RoomEvent.ActiveSpeakersChanged, (speakers) => setVoiceSpeaking(speakers.some((s) => (s as RemoteParticipant).isAgent)))
        .on(RoomEvent.Disconnected, () => {
          void relayRef.current?.stop()
          relayRef.current = null
          setRelayState('off')
          setPhase('ended')
        })
      await room.connect(body.url, body.token)
      await room.localParticipant.setMicrophoneEnabled(true)
      setPhase('joined')
    } catch (e) {
      const v = mapJoinError((e as Error).message || (e as Error).name, (e as { status?: number }).status)
      setError(v.message)
      setFatal(v.fatal)
      if (v.fatal) clearStoredClaim(typeof sessionStorage !== 'undefined' ? sessionStorage : undefined)
      setPhase('error')
      await roomRef.current?.disconnect()
    }
  }

  const toggleMute = async () => {
    const r = roomRef.current
    if (!r) return
    await r.localParticipant.setMicrophoneEnabled(muted)
    setMuted(!muted)
  }
  const leave = async () => {
    leftOnPurpose.current = true
    clearStoredClaim(typeof sessionStorage !== 'undefined' ? sessionStorage : undefined) // leaving on purpose: this phone does not silently rejoin
    setRejoinable(false)
    await relayRef.current?.stop()
    await roomRef.current?.disconnect()
    setPhase('ended')
  }

  const orbState: OrbState = phase !== 'joined' ? 'idle' : voiceSpeaking ? 'speaking' : holdTurn ? 'holding' : composing ? 'drafting' : 'listening'
  return (
    <div className="relative min-h-dvh">
      <Backdrop />
      <main id="partner-join" className="rv-join mx-auto grid max-w-2xl gap-4 sm:gap-5 sm:p-8">
        <header className="rv-enter flex items-center gap-3">
          <Logo />
          <div>
            <p className="text-lg font-extrabold tracking-tight">ReVOICE</p>
            <p className="rv-muted text-xs font-semibold">Partner view</p>
          </div>
        </header>
        <div className="rv-enter rv-enter-d1 grid justify-items-center gap-4 py-2 text-center sm:gap-6 sm:py-4">
          <h1 className="rv-hero-title">Join a <span className="rv-gradient-text">ReVOICE</span> conversation</h1>
          <Orb state={orbState} size={phase === 'joined' ? 170 : 120} reflection={phase === 'joined'} />
        </div>

        {(phase === 'consent' || phase === 'error' || phase === 'joining') && (
          <section aria-labelledby="disclosure-h" className="rv-canvas rv-enter rv-enter-d2 grid gap-4 p-4 sm:p-7">
            <h2 id="disclosure-h" className="rv-section-title">Before you join</h2>
            <ul className="grid gap-2 text-sm">
              {[
                <>The person you are talking with uses ReVOICE to communicate. Your speech will be <strong>transcribed live</strong> (by AssemblyAI) so they can read it and prepare replies.</>,
                <>AI may draft reply options for them (Groq). <strong>They approve every word</strong> before anything is spoken.</>,
                <>Their replies are spoken by a <strong>synthetic voice</strong>, which may be a clone of their own voice used with their consent.</>,
                <>ReVOICE does not record audio or save transcripts. The link expires 30 minutes after it was created and works once; if this phone reloads you can rejoin without a new link.</>,
                <>This is not an emergency service.</>,
              ].map((t, i) => (
                <li key={i} className="flex gap-2"><span className="rv-badge rv-badge-brand h-6 shrink-0 px-2" aria-hidden="true">{i + 1}</span><span>{t}</span></li>
              ))}
            </ul>
            {info.state === 'missing' && !rejoinable && <p role="alert" className="rv-alert rv-alert-warn">This page needs an invitation link.</p>}
            {info.state === 'malformed' && !rejoinable && <p role="alert" className="rv-alert rv-alert-warn">This link looks incomplete (a chat app may have cut it). Ask for the link again.</p>}
            {info.state === 'expired' && !rejoinable && <p role="alert" className="rv-alert rv-alert-warn">This invitation has expired. Ask for a new link.</p>}
            {info.state === 'valid' && info.exp && <p id="invite-expiry" role="status" className="rv-muted text-sm">This link expires in <strong>{formatRemaining(info.exp - now)}</strong>.</p>}
            {rejoinable && <p role="status" className="rv-alert text-sm">You were in this conversation on this phone. You can rejoin without a new link.</p>}
            <label className="grid gap-1 text-sm font-semibold">Your name (optional, shown to them)
              <input className="rv-input font-normal" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="rv-mode text-sm"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> <span>I understand and agree to my speech being transcribed for this conversation.</span></label>
            {error && <p role="alert" className="rv-alert rv-alert-danger">{error}</p>}
            <div className="flex flex-col gap-2 min-[400px]:flex-row">
              {(rejoinable || fatal === false) && rejoinable && (
                <button id="rejoin-button" className="rv-btn rv-btn-primary text-lg" disabled={!consent || phase === 'joining'} onClick={() => void join(true)}>
                  <Icon name="mic" size={18} /> {phase === 'joining' ? 'Joining…' : 'Rejoin'}
                </button>
              )}
              <button className={`rv-btn text-lg ${rejoinable ? '' : 'rv-btn-primary'}`} disabled={!consent || info.state !== 'valid' || (info.exp ? info.exp <= now : false) || phase === 'joining' || fatal} onClick={() => void join(false)}>
                <Icon name="mic" size={18} /> {phase === 'joining' ? 'Joining…' : phase === 'error' && !fatal ? 'Try again' : 'Join with microphone'}
              </button>
            </div>
          </section>
        )}

        {phase === 'joined' && (
          <section aria-labelledby="coach-h" className="rv-canvas rv-enter grid gap-5 p-4 text-center sm:p-8">
            <h2 id="coach-h" className="sr-only">Conversation status</h2>
            <div aria-live="polite" className="flex flex-wrap items-center justify-center gap-3 text-xl font-extrabold tracking-tight sm:text-2xl" style={{ minHeight: '4rem' }}>
              {voiceSpeaking ? <><span className="rv-eq" aria-hidden="true"><i /><i /><i /><i /></span> They are speaking…</>
                : holdTurn ? <><Icon name="hand" size={26} /> They have something to add — please pause.</>
                  : composing ? <><Icon name="edit" size={24} /> They are composing a reply…</>
                    : <><Icon name="headphones" size={24} /> Listening</>}
            </div>
            {relayState === 'on' && <p id="relay-indicator" role="status" className="rv-muted text-sm"><Icon name="mic" size={14} /> This phone is transcribing your speech so they can read it. Press Mute to pause.</p>}
            <ul className="grid gap-2 text-left text-sm sm:grid-cols-3">
              <li className="rv-panel p-3"><strong className="block">Speak, then pause</strong><span className="rv-muted">Give them time to compose — replies can take a little longer.</span></li>
              <li className="rv-panel p-3"><strong className="block">One question at a time</strong><span className="rv-muted">Yes/no is fine, but they may choose another answer.</span></li>
              <li className="rv-panel p-3"><strong className="block">Corrections are OK</strong><span className="rv-muted">If you change your mind mid-sentence, their drafts update.</span></li>
            </ul>
            <div className="flex flex-col justify-center gap-2 min-[400px]:flex-row">
              <button className="rv-btn" aria-pressed={muted} onClick={toggleMute}><Icon name="mic" size={16} /> {muted ? 'Unmute' : 'Mute me'}</button>
              <button className="rv-btn rv-btn-danger" onClick={leave}><Icon name="logout" size={16} /> Leave</button>
            </div>
          </section>
        )}

        {phase === 'ended' && (
          <section className="rv-canvas rv-pop p-6 text-center">
            <p className="text-lg font-semibold">{leftOnPurpose.current ? 'You have left the conversation. You can close this page.' : 'The conversation ended or the connection was lost.'}</p>
            {!leftOnPurpose.current && rejoinable && <button className="rv-btn rv-btn-primary mt-3" onClick={() => { setPhase('consent'); setConsent(false) }}>Rejoin</button>}
          </section>
        )}
      </main>
    </div>
  )
}
