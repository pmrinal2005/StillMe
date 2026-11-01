'use client'
/**
 * Partner-link mode. The partner joins via an expiring signed invite (in the URL fragment, so it
 * is never sent to servers in Referer headers or access logs), explicitly acknowledges that their
 * speech will be transcribed, and publishes ONLY a microphone track.
 *
 * Partner coaching view: shows when the ReVOICE user is composing (never the draft content) and
 * encourages patience. Approved synthetic speech from the worker plays here.
 */
import { useEffect, useRef, useState } from 'react'
import { Room, RoomEvent, Track, type RemoteParticipant } from 'livekit-client'
import { DataTopics, PresenceMessage } from '@/lib/contracts'
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
  const roomRef = useRef<Room | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const raw = decodeURIComponent(window.location.hash.replace(/^#/, ''))
    setInvite(raw)
    return () => void roomRef.current?.disconnect()
  }, [])

  const join = async () => {
    setError(null)
    setPhase('joining')
    try {
      const res = await fetch('/api/livekit/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ invite, label: label.trim() || 'Partner', consent: true }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `http_${res.status}`)
      const room = new Room({ audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      roomRef.current = room
      room
        .on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant, _k?: unknown, topic?: string) => {
          if (topic !== DataTopics.presence || !participant || participant.isAgent) return
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
          // Play ONLY the worker's approved synthetic voice (owner device publishes no audio in this mode).
          if (track.kind === Track.Kind.Audio && participant.isAgent) {
            const el = track.attach()
            el.dataset.revoice = 'voice'
            document.body.appendChild(el)
          }
        })
        .on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()))
        .on(RoomEvent.ActiveSpeakersChanged, (speakers) => setVoiceSpeaking(speakers.some((s) => (s as RemoteParticipant).isAgent)))
        .on(RoomEvent.Disconnected, () => setPhase('ended'))
      await room.connect(body.url, body.token)
      await room.localParticipant.setMicrophoneEnabled(true)
      setPhase('joined')
    } catch (e) {
      const code = (e as Error).message
      setError(
        code === 'invite_invalid_or_expired' ? 'This invitation is invalid or has expired. Ask for a new link.'
          : code === 'livekit_not_configured' ? 'Calling is not configured on this server.'
            : code.includes('Permission') || code.includes('NotAllowed') ? 'Microphone permission is needed to talk.'
              : `Could not join (${code}).`,
      )
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
                <>ReVOICE does not record audio or save transcripts. The link expires in 30 minutes.</>,
                <>This is not an emergency service.</>,
              ].map((t, i) => (
                <li key={i} className="flex gap-2"><span className="rv-badge rv-badge-brand h-6 shrink-0 px-2" aria-hidden="true">{i + 1}</span><span>{t}</span></li>
              ))}
            </ul>
            {!invite && <p role="alert" className="rv-alert rv-alert-warn">This page needs an invitation link.</p>}
            <label className="grid gap-1 text-sm font-semibold">Your name (optional, shown to them)
              <input className="rv-input font-normal" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="rv-mode text-sm"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> <span>I understand and agree to my speech being transcribed for this conversation.</span></label>
            {error && <p role="alert" className="rv-alert rv-alert-danger">{error}</p>}
            <button className="rv-btn rv-btn-primary text-lg" disabled={!consent || !invite || phase === 'joining'} onClick={join}>
              <Icon name="mic" size={18} /> {phase === 'joining' ? 'Joining…' : 'Join with microphone'}
            </button>
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
            <p className="text-lg font-semibold">You have left the conversation. You can close this page.</p>
          </section>
        )}
      </main>
    </div>
  )
}
