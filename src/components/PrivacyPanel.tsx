'use client'
import { useState } from 'react'
import { api } from '@/lib/client/api'
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
    if (!confirm('Delete all ReVOICE data on this device and on the ReVOICE server? This cannot be undone.')) return
    const r = await api.deleteServer().catch(() => null)
    const sb = getSupabase()
    if (sb) {
      // RLS: these deletes only ever affect the signed-in user's rows.
      for (const t of ['phrases', 'phrase_boards', 'style_cards', 'accessibility_prefs', 'voice_profiles', 'profiles'] as const) await sb.from(t).delete().not('user_id', 'is', null)
      await sb.auth.signOut()
    }
    await wipeLocal()
    setActions(r?.thirdPartyActions ?? [])
    setMsg('ReVOICE data deleted. Complete the third-party steps below. Reload to start fresh.')
  }

  return (
    <section id="privacy-panel" aria-labelledby="privacy-h" className="rv-glass rv-enter grid gap-3 p-4 text-sm sm:p-6">
      <h2 id="privacy-h" className="rv-section-title">Privacy & data</h2>
      <ul className="ml-5 list-disc">
        <li>No audio recording by ReVOICE. No saved transcripts. Live captions and suggestions live in memory only.</li>
        <li>No raw-content logging or analytics: server logs contain only counts, durations, request IDs and error categories.</li>
        <li>Phrase boards, message bank, voice registry and preferences are stored on this device.</li>
        <li><strong>Third parties</strong> process content under their own policies: AssemblyAI (speech), Groq (suggestions; enable Zero Data Retention — exception logs may otherwise be kept up to 30 days, US-based), LiveKit (media transport, no recording).</li>
        <li>Selecting the AssemblyAI EU region does not make the whole app EU-only (Groq is US-based).</li>
        <li>Not for real health information or clinical use.</li>
      </ul>
      <div className="flex flex-wrap gap-2">
        <button className="rv-btn" onClick={doExport}>Export my data (JSON)</button>
        <button className="rv-btn rv-btn-danger" onClick={doDelete}>Delete my data…</button>
      </div>
      {msg && <p role="status" className="rv-text-ok">{msg}</p>}
      {actions.length > 0 && (
        <div role="note">
          <p className="font-semibold">Deleting ReVOICE data does not delete data held by third parties:</p>
          <ul className="ml-5 list-disc">{actions.map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      )}
    </section>
  )
}
