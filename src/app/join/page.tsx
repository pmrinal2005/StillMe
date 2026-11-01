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

  return (
    <main id="partner-join" className="mx-auto grid max-w-2xl gap-4 p-4 sm:p-8">
      <h1 className="text-2xl font-extrabold">Join a ReVOICE conversation</h1>

      {(phase === 'consent' || phase === 'error' || phase === 'joining') && (
        <section aria-labelledby="disclosure-h" className="rv-panel grid gap-3 p-4">
          <h2 id="disclosure-h" className="text-lg font-bold">Before you join</h2>
          <ul className="ml-5 list-disc text-sm">
            <li>The person you are talking with uses ReVOICE to communicate. Your speech will be <strong>transcribed live</strong> (by AssemblyAI) so they can read it and prepare replies.</li>
            <li>AI may draft reply options for them (Groq). <strong>They approve every word</strong> before anything is spoken.</li>
            <li>Their replies are spoken by a <strong>synthetic voice</strong>, which may be a clone of their own voice used with their consent.</li>
            <li>ReVOICE does not record audio or save transcripts. The link expires in 30 minutes.</li>
            <li>This is not an emergency service.</li>
          </ul>
          {!invite && <p role="alert" style={{ color: 'var(--warn)' }}>This page needs an invitation link.</p>}
          <label className="grid text-sm">Your name (optional, shown to them)
            <input className="rv-input" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="flex gap-2"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I understand and agree to my speech being transcribed for this conversation.</label>
          {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
          <button className="rv-btn rv-btn-primary text-xl" disabled={!consent || !invite || phase === 'joining'} onClick={join}>
            {phase === 'joining' ? 'Joining…' : 'Join with microphone'}
          </button>
        </section>
      )}

      {phase === 'joined' && (
        <section aria-labelledby="coach-h" className="rv-panel grid gap-4 p-6 text-center">
          <h2 id="coach-h" className="sr-only">Conversation status</h2>
          <div aria-live="polite" className="text-2xl font-bold" style={{ minHeight: '4rem' }}>
            {voiceSpeaking ? '🔊 They are speaking…'
              : holdTurn ? '✋ They have something to add — please pause.'
                : composing ? '✍️ They are composing a reply…'
                  : '🎧 Listening'}
          </div>
          <div className="rv-muted grid gap-1 text-sm">
            <p>Tips: speak naturally, then pause. Give them time to compose — replies can take a little longer.</p>
            <p>Ask one question at a time. Yes/no questions are fine, but they may choose another answer.</p>
            <p>If you change your mind mid-sentence (“actually, not Tuesday…”), their draft suggestions update.</p>
          </div>
          <div className="flex justify-center gap-2">
            <button className="rv-btn" aria-pressed={muted} onClick={toggleMute}>{muted ? '🎙 Unmute' : '🔇 Mute me'}</button>
            <button className="rv-btn rv-btn-danger" onClick={leave}>Leave</button>
          </div>
        </section>
      )}

      {phase === 'ended' && (
        <section className="rv-panel p-4">
          <p>You have left the conversation. You can close this page.</p>
        </section>
      )}
    </main>
  )
}
