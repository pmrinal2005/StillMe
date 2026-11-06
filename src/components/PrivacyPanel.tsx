'use client'
import { useState } from 'react'
import { api, ApiError } from '@/lib/client/api'
import { exportLocal, wipeLocal } from '@/lib/client/db'

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** Data retention summary, export and deletion — with the third-party limitations stated plainly. No accounts: it is all about THIS DEVICE. */
export function PrivacyPanel() {
  const [msg, setMsg] = useState<string | null>(null)
  const [actions, setActions] = useState<string[]>([])
  const [failed, setFailed] = useState<string[]>([])
  const [deviceKey, setDeviceKey] = useState<string | null>(null)
  const [restoreKey, setRestoreKey] = useState('')
  const [keyMsg, setKeyMsg] = useState<string | null>(null)

  const showKey = async () => {
    setKeyMsg(null)
    try {
      setDeviceKey((await api.deviceKey()).key)
    } catch {
      setKeyMsg('Could not read the device key.')
    }
  }
  const doRestore = async () => {
    setKeyMsg(null)
    try {
      await api.restoreDevice(restoreKey.trim())
      setRestoreKey('')
      setDeviceKey(null)
      setKeyMsg('Device key restored. Reload the page to use that identity.')
    } catch (e) {
      setKeyMsg(e instanceof ApiError && e.code === 'invalid_key' ? 'That device key is not valid for this server.' : 'Could not restore the device key.')
    }
  }

  const doExport = async () => {
    const local = await exportLocal()
    const server = await api.exportServer().catch(() => null)
    download(`revoice-export-${new Date().toISOString().slice(0, 10)}.json`, { local, server })
    setMsg('Export downloaded.')
  }

  const doDelete = async () => {
    if (!confirm('Delete everything ReVOICE holds for this device: the server-side cloned-voice registrations and session records, and all phrase boards, settings and recordings stored in this browser? This cannot be undone.')) return
    setMsg(null)
    setFailed([])
    // The server performs the REAL deletion for this device (voices tombstoned, rooms closed, reservations settled, rows
    // removed) and reports each step. Only wipe this browser once the server says it all succeeded; a partial failure
    // keeps this device's identity so the user can retry.
    let r: Awaited<ReturnType<typeof api.deleteServer>> | null = null
    try {
      r = await api.deleteServer()
    } catch (e) {
      if (e instanceof ApiError && Array.isArray((e.body as { steps?: unknown }).steps)) {
        const steps = (e.body as { steps: { step: string; ok: boolean }[] }).steps
        setFailed(steps.filter((x) => !x.ok).map((x) => x.step))
        setActions(((e.body as { thirdPartyActions?: string[] }).thirdPartyActions) ?? [])
      }
      setMsg('Deletion did not complete on the server, so nothing was removed from this device. Try again.')
      return
    }
    await wipeLocal()
    setActions(r.thirdPartyActions ?? [])
    setMsg('This device’s ReVOICE data was deleted. Complete the third-party steps below. Reload to start fresh.')
  }

  return (
    <section id="privacy-panel" aria-labelledby="privacy-h" className="rv-glass rv-enter grid gap-3 p-4 text-sm sm:p-6">
      <h2 id="privacy-h" className="rv-section-title">Privacy & data</h2>
      <ul className="ml-5 list-disc">
        <li>No audio recording by ReVOICE. No saved transcripts. Live captions and suggestions live in memory only.</li>
        <li>No raw-content logging or analytics: server logs contain only counts, durations, request IDs and error categories.</li>
        <li>There are no accounts and no sign-in. Phrase boards, message bank and preferences are stored only on this device. Cloned-voice consent and ownership are recorded on the ReVOICE server against an anonymous device key (a voice id alone never grants use).</li>
        <li><strong>Third parties</strong> process content under their own policies: AssemblyAI (speech), Groq (suggestions; enable Zero Data Retention — exception logs may otherwise be kept up to 30 days, US-based), LiveKit (media transport, no recording).</li>
        <li>Selecting the AssemblyAI EU region does not make the whole app EU-only (Groq is US-based).</li>
        <li>Not for real health information or clinical use.</li>
      </ul>
      <div className="flex flex-wrap gap-2">
        <button className="rv-btn" onClick={doExport}>Export my data (JSON)</button>
        <button className="rv-btn rv-btn-danger" onClick={doDelete}>Delete my data…</button>
      </div>
      <div id="device-key-panel" className="rv-panel grid gap-2 p-3" role="group" aria-label="Device key">
        <p className="font-semibold">Device key</p>
        <p className="rv-muted">There is no sign-in. This browser is identified by an anonymous device key. Back it up to keep your registered cloned voices after clearing browser data, or paste a key here to use another device’s identity. Anyone who has the key acts as this device — keep it private.</p>
        <div className="flex flex-wrap gap-2">
          <button className="rv-btn" onClick={showKey}>Show my device key</button>
          {deviceKey && <button className="rv-btn" onClick={() => { void navigator.clipboard?.writeText(deviceKey).then(() => setKeyMsg('Copied.'), () => setKeyMsg('Copy failed — select the key and copy it manually.')) }}>Copy</button>}
        </div>
        {deviceKey && <code className="break-all rounded bg-black/10 p-2 text-xs" data-testid="device-key">{deviceKey}</code>}
        <label className="grid text-sm" htmlFor="restore-key">Restore a device key
          <input id="restore-key" className="rv-input" value={restoreKey} onChange={(e) => setRestoreKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder="paste a device key" />
        </label>
        <button className="rv-btn justify-self-start" disabled={restoreKey.trim().length < 40} onClick={doRestore}>Restore</button>
        {keyMsg && <p role="status">{keyMsg}</p>}
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
