'use client'
import type { StatusResponse } from '@/lib/client/api'
import { OUTPUT_LABELS, type OutputState } from '@/lib/output-state'

function Dot({ ok, label }: { ok: boolean | 'warn'; label: string }) {
  const color = ok === 'warn' ? 'var(--warn)' : ok ? 'var(--ok)' : 'var(--danger)'
  return (
    <span className="rv-badge">
      <span className="rv-dot" style={{ background: color }} aria-hidden="true" />
      {label}
      <span className="sr-only">{ok === 'warn' ? ' (limited)' : ok ? ' (available)' : ' (unavailable)'}</span>
    </span>
  )
}

/** Always-visible connection, voice-consent and budget status. Color is never the only signal. */
export function StatusBar(props: {
  status: StatusResponse | null
  online: boolean
  output: OutputState
  listening: string
  voiceLabel: string
  voiceWarning?: string | null
}) {
  const { status, online, output, listening, voiceLabel, voiceWarning } = props
  const p = status?.providers
  const b = status?.budget.user
  return (
    <section id="status-bar" aria-label="System status" className="rv-panel flex flex-wrap items-center gap-2 p-3 text-sm">
      <Dot ok={online} label={online ? 'Online' : 'Offline — local phrases and device voice only'} />
      <Dot ok={!!p?.assemblyai} label={p?.assemblyai ? 'Voice service' : 'Voice service not configured'} />
      <Dot ok={p?.groq ? true : 'warn'} label={p?.groq ? 'Suggestions' : 'Suggestions off'} />
      <Dot ok={p?.livekit || p?.browserStt ? true : 'warn'} label={p?.livekit ? 'Listening (LiveKit)' : p?.browserStt ? 'Listening (direct demo)' : 'Listening unavailable'} />
      <span className="rv-badge" aria-live="polite">Listening: {listening}</span>
      <span className="rv-badge" aria-live="polite">Output: {OUTPUT_LABELS[output.kind]}</span>
      <span className="rv-badge">Voice: {voiceLabel}</span>
      {voiceWarning && <span className="rv-badge" style={{ borderColor: 'var(--warn)' }} role="status">⚠ {voiceWarning}</span>}
      {b && (
        <span className="rv-badge" title="Application budget ledger (estimates; reconcile with provider dashboards)">
          Today: {b.tts.chars}/{b.tts.charsLimit} chars · {b.stt.minutes}/{b.stt.minutesLimit} listen min · {b.groq.requests}/{b.groq.requestsLimit} suggestions · ${b.usd.today.toFixed(3)}/${b.usd.todayLimit}
        </span>
      )}
      {status?.identity.kind === 'local-demo' && <span className="rv-badge" style={{ borderColor: 'var(--warn)' }}>Local prototype identity (Supabase not configured)</span>}
      {status && !status.providers.durableStore && <span className="rv-badge rv-muted">Single-instance stores</span>}
    </section>
  )
}
