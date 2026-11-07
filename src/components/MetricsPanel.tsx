'use client'
import { useEffect, useState } from 'react'
import { summary } from '@/lib/client/metrics'
import type { StatusResponse } from '@/lib/client/api'

/** Content-free session metrics: latency percentiles (monotonic clock), authorship, corrections, cost per approved turn. */
export function MetricsPanel({ status }: { status: StatusResponse | null }) {
  const [s, setS] = useState(summary())
  useEffect(() => {
    const t = setInterval(() => setS(summary()), 2000)
    return () => clearInterval(t)
  }, [])
  const c = s.counters
  const usd = status?.budget.user.usd.today ?? 0
  const aiTotal = c.aiApproved + c.aiRejected
  return (
    <section id="metrics-panel" aria-labelledby="metrics-h" className="rv-glass rv-enter p-4 text-sm sm:p-6">
      <h2 id="metrics-h" className="rv-section-title mb-2">Session measurements</h2>
      <p className="rv-muted mb-2">Measured on this device. Engineering targets, not guarantees: warm approval→audio p50 &lt; 500 ms, p95 &lt; 1.2 s; Stop &lt; 150 ms.</p>
      <table className="rv-table">
        <caption className="sr-only">Latency intervals</caption>
        <thead><tr><th>Interval</th><th>n</th><th>p50 ms</th><th>p95 ms</th></tr></thead>
        <tbody>
          {s.intervals.length === 0 && <tr><td colSpan={4} className="rv-muted">No measurements yet.</td></tr>}
          {s.intervals.map((i) => <tr key={i.name}><td>{i.name.replace(/_/g, ' ')}</td><td>{i.n}</td><td>{i.p50 ?? '—'}</td><td>{i.p95 ?? '—'}</td></tr>)}
        </tbody>
      </table>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1">
        <dt className="rv-muted">Approved turns</dt><dd>{c.approvedTurns}</dd>
        <dt className="rv-muted">Typed / phrase</dt><dd>{c.typed}</dd>
        <dt className="rv-muted">AI used as-is / edited</dt><dd>{c.aiApproved - c.aiEdited} / {c.aiEdited}</dd>
        <dt className="rv-muted">AI suggestion sets not used</dt><dd>{c.aiRejected}{aiTotal ? ` (${Math.round((c.aiRejected / aiTotal) * 100)}%)` : ''}</dd>
        <dt className="rv-muted">Stops</dt><dd>{c.stops}</dd>
        <dt className="rv-muted">Delivery uncertain</dt><dd>{c.uncertain}</dd>
        <dt className="rv-muted">Worker fallbacks (spoken from device)</dt><dd>{c.routeFallbacks}</dd>
        <dt className="rv-muted">Auto turn-taking: spoken / cancelled / blocked</dt><dd>{c.autoSpoken} / {c.autoCancelled} / {c.autoBlocked}</dd>
        <dt className="rv-muted">Unapproved speech</dt><dd>{c.unapprovedSpeech}</dd>
        <dt className="rv-muted">Est. cost / approved turn (today)</dt><dd>{c.approvedTurns ? `$${(usd / c.approvedTurns).toFixed(4)}` : '—'}</dd>
      </dl>
    </section>
  )
}
