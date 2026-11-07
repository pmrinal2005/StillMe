'use client'
import type { StatusResponse } from '@/lib/client/api'
import { OUTPUT_LABELS, type OutputState } from '@/lib/output-state'
import { Icon } from './ui/Icon'

function Pill({ ok, label }: { ok: boolean | 'warn'; label: string }) {
  const cls = ok === 'warn' ? 'rv-badge rv-badge-warn' : ok ? 'rv-badge rv-badge-ok' : 'rv-badge rv-badge-danger'
  return (
    <li className={cls}>
      <span className="rv-dot" style={{ background: 'currentColor' }} aria-hidden="true" />
      {label}
      <span className="sr-only">{ok === 'warn' ? ' (limited)' : ok ? ' (available)' : ' (unavailable)'}</span>
    </li>
  )
}

function Meter({ label, used, limit, unit }: { label: string; used: number; limit: number; unit?: string }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="rv-muted font-semibold">{label}</span>
        <span className="font-bold tabular-nums">{unit === '$' ? `$${used.toFixed(3)} / $${limit}` : `${used} / ${limit}${unit ? ` ${unit}` : ''}`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'rgba(90,70,140,.12)' }} role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct > 85 ? 'var(--danger)' : 'linear-gradient(90deg, var(--pink-deep), var(--violet))', transition: 'width .6s ease' }} />
      </div>
    </div>
  )
}

/** Always-visible connection, voice-consent and budget status. Colour is never the only signal (text + sr labels). */
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
    <section id="status-bar" aria-label="System status" className="grid gap-2">
      <ul className="flex flex-wrap items-center gap-1.5 text-sm" role="list">
        <Pill ok={online} label={online ? 'Online' : 'Offline — local phrases & device voice'} />
        <Pill ok={!!p?.assemblyai} label={p?.assemblyai ? 'Voice service' : 'Voice service not configured'} />
        <Pill ok={p?.groq ? true : 'warn'} label={p?.groq ? 'Suggestions' : 'Suggestions off'} />
        <Pill ok={p?.livekit || p?.browserStt ? true : 'warn'} label={p?.livekit ? 'Listening (LiveKit)' : p?.browserStt ? 'Listening (this device)' : 'Listening unavailable'} />
        <li className="rv-badge" aria-live="polite">
          {listening === 'listening' ? <span className="rv-eq" aria-hidden="true"><i /><i /><i /><i /></span> : <Icon name="headphones" size={13} />}
          Listening: {listening}
        </li>
        <li className={`rv-badge ${output.kind === 'speaking' ? 'rv-badge-brand' : ''}`} aria-live="polite">
          {output.kind === 'speaking' ? <span className="rv-eq" aria-hidden="true"><i /><i /><i /><i /></span> : <Icon name="voice" size={13} />}
          Output: {OUTPUT_LABELS[output.kind]}
        </li>
        <li className="rv-badge hidden sm:inline-flex"><Icon name="user" size={13} />Voice: {voiceLabel}</li>
        {voiceWarning && <li className="rv-badge rv-badge-warn" role="status"><Icon name="alert" size={13} />{voiceWarning}</li>}
        {status && !status.providers.durableStore && <li className="rv-badge hidden md:inline-flex">Single-instance stores</li>}
      </ul>
      {b && (
        <details className="rv-glass px-4 py-2 text-sm">
          <summary className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1 font-semibold">
            <span className="flex items-center gap-2 whitespace-nowrap"><Icon name="chart" size={15} /> Today’s budget <span className="rv-muted font-normal">· ${b.usd.today.toFixed(3)} of ${b.usd.todayLimit}</span></span>
            <span className="rv-muted hidden text-xs sm:inline">estimates — reconcile with provider dashboards</span>
          </summary>
          <div className="grid gap-3 py-2 sm:grid-cols-4">
            <Meter label="Voice characters" used={b.tts.chars} limit={b.tts.charsLimit} />
            {b.stt.minutesLimit > 0 ? (
              <Meter label="Listening minutes" used={b.stt.minutes} limit={b.stt.minutesLimit} unit="min" />
            ) : (
              <div className="grid gap-1 text-xs">
                <span className="rv-muted font-semibold">Listening minutes</span>
                <span className="font-bold tabular-nums">{b.stt.minutes} min today · no daily cap</span>
              </div>
            )}
            <Meter label="Suggestions" used={b.groq.requests} limit={b.groq.requestsLimit} />
            <Meter label="Spend today" used={b.usd.today} limit={b.usd.todayLimit} unit="$" />
          </div>
        </details>
      )}
    </section>
  )
}
