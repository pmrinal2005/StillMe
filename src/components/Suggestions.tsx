'use client'
import type { Candidate, CandidateSet } from '@/lib/contracts'
import { Icon } from './ui/Icon'

const INTENT_LABEL: Record<Candidate['intent'], string> = {
  continue: 'Continue',
  clarify: 'Ask / clarify',
  decline: 'Decline / alternative',
  custom: 'Your intent',
}

/**
 * "Intent Compass" + "Turn Passport". Candidates are drafts: choosing one loads it into the
 * composer for review — it is never spoken from here. Positions are stable while the user is
 * engaged: replacement sets are offered, not swapped under the selection cursor.
 */
export function Suggestions(props: {
  set: CandidateSet | null
  pending: CandidateSet | null
  stale: string | null
  loading: boolean
  error: string | null
  passport: { turnId: number; revision: number; final: boolean } | null
  onEngage: () => void
  onUse: (c: Candidate, set: CandidateSet) => void
  onAcceptPending: () => void
  onFeedback: (c: Candidate, verdict: 'sounds_like_me' | 'not_my_meaning') => void
  onRegenerate: () => void
  preferredIntent: string
  setPreferredIntent: (s: string) => void
}) {
  const { set, pending, stale, loading, error, passport } = props
  return (
    <section id="suggestions-panel" aria-labelledby="sugg-h" className="rv-glass rv-enter grid gap-3 p-4 sm:p-5" onFocusCapture={props.onEngage} onPointerDown={props.onEngage}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="rv-eyebrow">Intent compass</p>
          <h2 id="sugg-h" className="rv-section-title flex items-center gap-2">
            <Icon name="sparkle" size={17} /> Suggested replies
            <span className="rv-muted text-sm font-normal">drafts — nothing is spoken until you approve</span>
          </h2>
        </div>
        {passport && set && (
          <span className="rv-badge rv-badge-brand" title="Turn Passport: which partner turn and transcript revision these suggestions answer">
            <Icon name="link" size={13} /> Answers turn #{passport.turnId} · rev {set.turn.revision} · {set.status === 'final' ? 'final transcript' : 'partial transcript'}
          </span>
        )}
      </header>

      <div aria-live="polite" className="grid gap-2 text-sm empty:hidden">
        {loading && <p className="rv-muted flex items-center gap-2"><span className="rv-eq" aria-hidden="true"><i /><i /><i /><i /></span> Drafting…</p>}
        {error && <p className="rv-alert rv-alert-warn">{error}</p>}
        {stale && (
          <p role="alert" className="rv-alert rv-alert-warn">
            <Icon name="alert" size={16} /> Conversation Brake: these suggestions no longer match what was said ({stale.replace(/_/g, ' ')}). Review before using.
          </p>
        )}
      </div>

      {pending && (
        <button data-scan className="rv-btn w-full rv-pop" onClick={props.onAcceptPending}>
          <Icon name="refresh" size={16} /> Updated suggestions available — show them
        </button>
      )}

      {set ? (
        <ol className="grid gap-3 md:grid-cols-3" role="list">
          {set.candidates.map((c, i) => (
            <li key={c.id} data-intent={c.intent} className={`rv-sugg rv-enter rv-enter-d${i + 1} ${stale ? 'is-stale' : ''}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="rv-badge">{INTENT_LABEL[c.intent]}</span>
                {c.risk !== 'none' && <span className="rv-badge rv-badge-warn">Review carefully: {c.risk}</span>}
              </div>
              <p className="flex-1 text-lg font-medium leading-snug">{c.text}</p>
              <button data-scan className="rv-btn rv-btn-primary" disabled={!!stale} onClick={() => props.onUse(c, set)} aria-label={`Use suggestion: ${c.text}`}>
                <Icon name="edit" size={16} /> Use (edit before speaking)
              </button>
              <div className="flex gap-2">
                <button className="rv-btn flex-1 text-xs" onClick={() => props.onFeedback(c, 'sounds_like_me')}><Icon name="heart" size={14} /> Sounds like me</button>
                <button className="rv-btn flex-1 text-xs" onClick={() => props.onFeedback(c, 'not_my_meaning')}><Icon name="thumbDown" size={14} /> Not my meaning</button>
              </div>
            </li>
          ))}
        </ol>
      ) : loading ? (
        <div className="grid gap-3 md:grid-cols-3" aria-hidden="true">
          {[0, 1, 2].map((i) => <div key={i} className="rv-shimmer h-40" />)}
        </div>
      ) : (
        <p className="rv-muted">Suggestions appear while your partner speaks. You can always ignore them and write your own words.</p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-sm font-semibold">
          Preferred third intent (optional)
          <input className="rv-input font-normal" maxLength={80} placeholder="e.g. change the subject, make a joke" value={props.preferredIntent} onChange={(e) => props.setPreferredIntent(e.target.value)} />
        </label>
        <button className="rv-btn" onClick={props.onRegenerate} disabled={loading}><Icon name="refresh" size={16} /> Redraft</button>
      </div>
    </section>
  )
}
