'use client'
/**
 * Provider-usage reconciliation (operator). The app ledger is an estimate; record what the
 * AssemblyAI / Groq / LiveKit dashboards actually report and review drift. Content-free.
 */
import { useEffect, useState } from 'react'
import { api, ApiError } from '@/lib/client/api'

type Data = Awaited<ReturnType<typeof api.reconcileGet>>

export function ReconcilePanel() {
  const [data, setData] = useState<Data | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [provider, setProvider] = useState('assemblyai')
  const [usd, setUsd] = useState('')
  const today = new Date().toISOString().slice(0, 10)
  const [start, setStart] = useState(today.slice(0, 8) + '01')
  const [end, setEnd] = useState(today)
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<string | null>(null)

  const load = () => api.reconcileGet().then(setData, (e) => setErr(e instanceof ApiError ? e.code : 'error'))
  useEffect(() => {
    void load()
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setMsg(null)
    try {
      const r = await api.reconcilePost({ provider, periodStart: start, periodEnd: end, providerReportedUsd: usd === '' ? null : Number(usd), note })
      setMsg(r.result ? `Recorded. Drift: ${r.result.driftUsd ?? '—'} USD (${r.result.status.replace(/_/g, ' ')})` : 'Recorded.')
      setUsd('')
      void load()
    } catch (e2) {
      setMsg(`Could not record (${e2 instanceof ApiError ? e2.code : 'error'}).`)
    }
  }

  if (err === 'forbidden') return null
  return (
    <section id="reconcile-panel" aria-labelledby="reconcile-h" className="rv-panel grid gap-2 p-4 text-sm">
      <h2 id="reconcile-h" className="text-lg font-bold">Reconcile with provider dashboards</h2>
      <p className="rv-muted">App figures are estimates, not provider-enforced caps. Enter what each dashboard reports after smoke tests and monthly.</p>
      {data && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
          <dt className="rv-muted">App-estimated AssemblyAI spend</dt><dd>${data.estimate.assemblyaiUsd.toFixed(4)} ({data.estimate.source})</dd>
          <dt className="rv-muted">Phone minutes ({data.estimate.phone.month})</dt><dd>{data.estimate.phone.minutesUsed} / {data.estimate.phone.cap}</dd>
          <dt className="rv-muted">Latest AssemblyAI drift</dt><dd>{data.assemblyai ? `${data.assemblyai.driftUsd ?? '—'} USD · ${data.assemblyai.status.replace(/_/g, ' ')}` : 'not recorded yet'}</dd>
        </dl>
      )}
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2">
        <label className="grid">Provider
          <select className="rv-input" value={provider} onChange={(e) => setProvider(e.target.value)}>
            {['assemblyai', 'groq', 'livekit', 'supabase', 'vercel'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="grid">Provider-reported USD (blank if none)
          <input className="rv-input" inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value.replace(/[^0-9.]/g, ''))} />
        </label>
        <label className="grid">Period start<input className="rv-input" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="grid">Period end<input className="rv-input" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        <label className="grid sm:col-span-2">Note (no conversation content)<input className="rv-input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <button className="rv-btn rv-btn-primary sm:col-span-2" type="submit">Record figures</button>
      </form>
      {msg && <p role="status">{msg}</p>}
      {data && data.recorded.length > 0 && (
        <table className="w-full text-left">
          <caption className="sr-only">Recorded provider figures</caption>
          <thead><tr><th>Provider</th><th>Period</th><th>USD</th></tr></thead>
          <tbody>{data.recorded.slice(0, 8).map((r, i) => <tr key={i}><td>{r.provider}</td><td>{r.periodStart} → {r.periodEnd}</td><td>{r.providerReportedUsd ?? '—'}</td></tr>)}</tbody>
        </table>
      )}
    </section>
  )
}
