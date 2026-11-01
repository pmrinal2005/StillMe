'use client'
import type { Candidate, CandidateSet } from '@/lib/contracts'

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
    <section id="suggestions-panel" aria-labelledby="sugg-h" className="rv-panel p-4" onFocusCapture={props.onEngage} onPointerDown={props.onEngage}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="sugg-h" className="text-lg font-bold">Suggested replies <span className="rv-muted text-sm font-normal">(drafts — nothing is spoken until you approve)</span></h2>
        {passport && set && (
          <span className="rv-badge" title="Turn Passport: which partner turn and transcript revision these suggestions answer">
            Answers turn #{passport.turnId} · rev {set.turn.revision} · {set.status === 'final' ? 'final transcript' : 'partial transcript'}
          </span>
        )}
      </div>
      <div aria-live="polite" className="min-h-6 text-sm">
        {loading && <p className="rv-muted">Drafting…</p>}
        {error && <p style={{ color: 'var(--warn)' }}>{error}</p>}
        {stale && (
          <p role="alert" style={{ color: 'var(--warn)' }}>
            Conversation Brake: these suggestions no longer match what was said ({stale.replace(/_/g, ' ')}). Review before using.
          </p>
        )}
      </div>
      {pending && (
        <button data-scan className="rv-btn mb-2 w-full" onClick={props.onAcceptPending}>
          Updated suggestions available — show them
        </button>
      )}
      {set ? (
        <ol className="grid gap-2 md:grid-cols-3" role="list">
          {set.candidates.map((c) => (
            <li key={c.id} className="rv-panel flex flex-col gap-2 p-3" style={{ background: 'var(--panel-2)' }}>
              <span className="rv-badge self-start">{INTENT_LABEL[c.intent]}</span>
              {c.risk !== 'none' && (
                <span className="rv-badge self-start" style={{ borderColor: 'var(--warn)' }}>
                  Review carefully: {c.risk}
                </span>
              )}
              <p className="text-lg">{c.text}</p>
              <button data-scan className="rv-btn rv-btn-primary" disabled={!!stale} onClick={() => props.onUse(c, set)} aria-label={`Use suggestion: ${c.text}`}>
                Use (edit before speaking)
              </button>
              <div className="flex gap-2">
                <button className="rv-btn flex-1 text-sm" onClick={() => props.onFeedback(c, 'sounds_like_me')}>Sounds like me</button>
                <button className="rv-btn flex-1 text-sm" onClick={() => props.onFeedback(c, 'not_my_meaning')}>Not my meaning</button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        !loading && <p className="rv-muted">Suggestions appear while your partner speaks. You can always ignore them and write your own words.</p>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-1 flex-col text-sm">
          Preferred third intent (optional)
          <input className="rv-input" maxLength={80} placeholder="e.g. change the subject, make a joke" value={props.preferredIntent} onChange={(e) => props.setPreferredIntent(e.target.value)} />
        </label>
        <button className="rv-btn" onClick={props.onRegenerate} disabled={loading}>Redraft</button>
      </div>
    </section>
  )
}
