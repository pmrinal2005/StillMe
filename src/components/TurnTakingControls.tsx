'use client'
import { useId } from 'react'
import { Icon } from './ui/Icon'
import type { Prefs } from './usePrefs'
import {
  AUTO_PHASE_LABEL,
  INTENT_PREFS,
  MAX_CONSECUTIVE_AUTO,
  SILENCE_MAX_MS,
  SILENCE_MIN_MS,
  VETO_MAX_MS,
  VETO_MIN_MS,
  type AutoTurnSnapshot,
  type IntentPref,
} from '@/lib/turn-taking'

const INTENT_LABEL: Record<IntentPref, string> = {
  auto: 'Automatic — a question gets a clarifying reply, otherwise keep the conversation going',
  continue: 'Keep the conversation going',
  clarify: 'Ask a clarifying question',
  decline: 'Politely decline / offer an alternative',
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

/**
 * Settings for AUTO TURN-TAKING. Off by default. It is a standing, revocable delegation: after your partner pauses, ReVOICE drafts
 * a reply, shows it with a veto countdown, and only then speaks it through the same server-signed approval as everything else.
 */
export function TurnTakingSettings({ prefs, update, onToggle, compact = false }: { prefs: Prefs; update: (p: Partial<Prefs>) => void; onToggle: (on: boolean) => void; compact?: boolean }) {
  const uid = useId()
  return (
    <fieldset id="turn-taking-settings" className="rv-panel grid gap-3 p-4" aria-describedby={`${uid}-note`}>
      <legend className="rv-badge rv-badge-brand px-3 text-sm">Auto turn-taking</legend>
      <label className="flex gap-2 text-sm font-semibold">
        <input type="checkbox" checked={prefs.autoTurn} onChange={(e) => onToggle(e.target.checked)} />
        <span>Let StillMe reply after my partner pauses (you can cancel every reply)</span>
      </label>
      <p id={`${uid}-note`} className="rv-muted text-xs">
        Off by default. When on: after your partner stops, StillMe drafts a reply, shows it, and speaks it in your voice after a countdown — unless you press Cancel, type, or touch the suggestions.
        It never replies to health, legal, money or consent topics, never agrees to things for you, and pauses after {MAX_CONSECUTIVE_AUTO} automatic replies in a row until you act.
      </p>
      {!compact && (
        <>
          <label className="grid text-sm">
            Wait for a pause of: {seconds(prefs.autoSilenceMs)} s
            <input type="range" min={SILENCE_MIN_MS} max={SILENCE_MAX_MS} step={100} value={prefs.autoSilenceMs} onChange={(e) => update({ autoSilenceMs: Number(e.target.value) })} aria-valuetext={`${seconds(prefs.autoSilenceMs)} seconds`} />
            <span className="rv-muted text-xs">Between {seconds(SILENCE_MIN_MS)} and {seconds(SILENCE_MAX_MS)} s. Longer = fewer interruptions.</span>
          </label>
          <label className="grid text-sm">
            Time to cancel before it speaks: {seconds(prefs.autoVetoMs)} s
            <input type="range" min={VETO_MIN_MS} max={VETO_MAX_MS} step={500} value={prefs.autoVetoMs} onChange={(e) => update({ autoVetoMs: Number(e.target.value) })} aria-valuetext={`${seconds(prefs.autoVetoMs)} seconds`} />
            <span className="rv-muted text-xs">Between {seconds(VETO_MIN_MS)} and {seconds(VETO_MAX_MS)} s. Slower access methods should choose longer.</span>
          </label>
          <label className="grid text-sm">
            What kind of reply
            <select className="rv-input" value={prefs.autoIntent} onChange={(e) => update({ autoIntent: e.target.value as IntentPref })}>
              {INTENT_PREFS.map((k) => <option key={k} value={k}>{INTENT_LABEL[k]}</option>)}
            </select>
          </label>
          <p className="rv-muted text-xs">Needs suggestions on (Groq). The “Ask me to confirm before speaking” setting does not apply here — the countdown is the confirmation.</p>
        </>
      )}
    </fieldset>
  )
}

/** Live status of auto turn-taking while listening: silence meter, the drafted reply, the veto countdown and why something was blocked. */
export function TurnTakingCard({ snap, onCancel, onSayIt, onDismiss }: { snap: AutoTurnSnapshot | null; onCancel: () => void; onSayIt: () => void; onDismiss: () => void }) {
  const uid = useId()
  if (!snap || !snap.enabled) return null
  const counting = snap.phase === 'countdown' && snap.pick
  const pct = (n: number) => Math.round(n * 100)
  const noticeTone = snap.notice?.kind === 'blocked' ? 'rv-alert-warn' : snap.notice?.kind === 'cancelled' ? 'rv-alert-warn' : 'rv-alert-info'
  return (
    <section id="turn-taking-card" aria-labelledby={`${uid}-h`} className="rv-glass rv-enter grid gap-3 p-4 sm:p-5" data-phase={snap.phase}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="rv-eyebrow">Auto turn-taking · you can cancel every reply</p>
          <h2 id={`${uid}-h`} className="rv-section-title flex items-center gap-2"><Icon name="clock" size={17} /> Your turn</h2>
        </div>
        <span className="rv-badge" title="Automatic replies since you last did something yourself">
          {snap.consecutive}/{snap.maxConsecutive} automatic in a row
        </span>
      </header>

      <p className="flex items-center gap-2 text-sm font-semibold" role="status" aria-live="polite">
        <Icon name={snap.phase === 'speaking' ? 'voice' : snap.phase === 'drafting' ? 'sparkle' : snap.phase === 'countdown' ? 'clock' : 'mic'} size={15} />
        {AUTO_PHASE_LABEL[snap.phase]}
      </p>

      {(snap.phase === 'listening' || snap.phase === 'idle') && (
        <div className="grid gap-1">
          <div className="rv-meter" role="progressbar" aria-label="Silence since your partner stopped" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(snap.silenceProgress)}>
            <span style={{ width: `${pct(snap.silenceProgress)}%` }} />
          </div>
          <p className="rv-muted text-xs">I reply after {seconds(snap.silenceMs)} s of quiet.</p>
        </div>
      )}

      {snap.phase === 'drafting' && (
        <p className="rv-muted flex items-center gap-2 text-sm"><span className="rv-eq" aria-hidden="true"><i /><i /><i /><i /></span> Drafting a reply…</p>
      )}

      {counting && snap.pick && (
        <div className="rv-panel grid gap-3 p-3 sm:p-4">
          <p className="text-xl font-medium break-words">“{snap.pick.text}”</p>
          <div className="grid gap-1">
            <div className="rv-meter rv-meter-veto" role="progressbar" aria-label="Time left to cancel" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(snap.vetoProgress)}>
              <span style={{ width: `${pct(snap.vetoProgress)}%` }} />
            </div>
            <p className="text-sm font-semibold" aria-live="off">Speaking in {Math.max(1, Math.ceil(snap.vetoRemainingMs / 1000))} s — cancel if this is not what you mean.</p>
          </div>
          <div className="flex flex-col gap-2 min-[400px]:flex-row">
            <button id="auto-cancel" data-scan className="rv-btn rv-btn-danger flex-1" autoFocus onClick={onCancel}>
              <Icon name="x" size={16} /> Cancel
            </button>
            <button id="auto-say-it" data-scan className="rv-btn rv-btn-primary flex-1" onClick={onSayIt}>
              <Icon name="send" size={16} /> Say it now
            </button>
          </div>
          <p className="rv-muted text-xs">Typing, touching a suggestion, Esc, or your partner talking again also cancels it.</p>
        </div>
      )}

      {snap.notice && snap.phase !== 'countdown' && (
        <p role="status" className={`rv-alert ${noticeTone} text-sm`}>
          <Icon name="alert" size={15} /> <span className="flex-1">{snap.notice.message}</span>
          <button className="rv-btn text-sm" onClick={onDismiss}>OK</button>
        </p>
      )}
    </section>
  )
}
