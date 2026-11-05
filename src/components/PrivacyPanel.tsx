'use client'
import { useState } from 'react'
import { api, ApiError } from '@/lib/client/api'
import { exportLocal, wipeLocal } from '@/lib/client/db'
import { getSupabase } from '@/lib/client/supabase'

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

const REMOTE_TABLES = ['profiles', 'accessibility_prefs', 'style_cards', 'voice_profiles', 'biometric_consents', 'phrase_boards', 'phrases', 'conversation_sessions', 'usage_events', 'audit_events'] as const

/** Data retention summary, export and deletion — with the third-party limitations stated plainly. */
export function PrivacyPanel() {
  const [msg, setMsg] = useState<string | null>(null)
  const [actions, setActions] = useState<string[]>([])
  const [failed, setFailed] = useState<string[]>([])

  const doExport = async () => {
    const local = await exportLocal()
    const server = await api.exportServer().catch(() => null)
    const remote: Record<string, unknown> = {}
    const sb = getSupabase()
    if (sb) for (const t of REMOTE_TABLES) remote[t] = (await sb.from(t).select('*').limit(1000)).data ?? []
    download(`revoice-export-${new Date().toISOString().slice(0, 10)}.json`, { local, server, supabase: sb ? remote : 'not configured' })
    setMsg('Export downloaded.')
  }

  const doDelete = async () => {
    if (!confirm('Delete your ReVOICE account, cloud data and cloned-voice registrations, and all data on this device? This cannot be undone.')) return
    setMsg(null)
    setFailed([])
    // B19: the server performs the REAL deletion (voices tombstoned, rooms closed, reservations settled, rows and auth
    // user removed) and reports each step. Only wipe this device / sign out once the server says it all succeeded —
    // a partial failure keeps the account signed in so the user can retry.
    let r: Awaited<ReturnType<typeof api.deleteServer>> | null = null
    try {
      r = await api.deleteServer()
    } catch (e) {
      if (e instanceof ApiError && Array.isArray((e.body as { steps?: unknown }).steps)) {
        const steps = (e.body as { steps: { step: string; ok: boolean }[] }).steps
        setFailed(steps.filter((x) => !x.ok).map((x) => x.step))
        setActions(((e.body as { thirdPartyActions?: string[] }).thirdPartyActions) ?? [])
      }
      setMsg('Deletion did not complete on the server, so nothing was removed from this device and you are still signed in. Try again.')
      return
    }
    const sb = getSupabase()
    if (sb) await sb.auth.signOut().catch(() => undefined)
    await wipeLocal()
    setActions(r.thirdPartyActions ?? [])
    setMsg('ReVOICE account and data deleted. Complete the third-party steps below. Reload to start fresh.')
  }

  return (
    <section id="privacy-panel" aria-labelledby="privacy-h" className="rv-glass rv-enter grid gap-3 p-4 text-sm sm:p-6">
      <h2 id="privacy-h" className="rv-section-title">Privacy & data</h2>
      <ul className="ml-5 list-disc">
        <li>No audio recording by ReVOICE. No saved transcripts. Live captions and suggestions live in memory only.</li>
        <li>No raw-content logging or analytics: server logs contain only counts, durations, request IDs and error categories.</li>
        <li>Phrase boards, message bank and preferences are stored on this device. Cloned-voice consent and ownership are recorded on the ReVOICE server (a voice id alone never grants use).</li>
        <li><strong>Third parties</strong> process content under their own policies: AssemblyAI (speech), Groq (suggestions; enable Zero Data Retention — exception logs may otherwise be kept up to 30 days, US-based), LiveKit (media transport, no recording).</li>
        <li>Selecting the AssemblyAI EU region does not make the whole app EU-only (Groq is US-based).</li>
        <li>Not for real health information or clinical use.</li>
      </ul>
      <div className="flex flex-wrap gap-2">
        <button className="rv-btn" onClick={doExport}>Export my data (JSON)</button>
        <button className="rv-btn rv-btn-danger" onClick={doDelete}>Delete my data…</button>
      </div>
      {msg && <p role="status" className={failed.length || msg.startsWith('Deletion did not') ? 'rv-text-danger' : 'rv-text-ok'}>{msg}</p>}
      {failed.length > 0 && <p role="alert" className="rv-text-danger">Failed steps: {failed.join(', ')}</p>}
      {actions.length > 0 && (
        <div role="note">
          <p className="font-semibold">Deleting ReVOICE data does not delete data held by third parties:</p>
          <ul className="ml-5 list-disc">{actions.map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      )}
    </section>
  )
}
