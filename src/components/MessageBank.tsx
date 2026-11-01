'use client'
import { useEffect, useRef, useState } from 'react'
import { db, uid, type BankedMessage } from '@/lib/client/db'

/**
 * Message banking: ORIGINAL recordings of personally meaningful phrases, made by the user
 * (or with their consent). Stored only on this device; never uploaded; works offline.
 * These are not synthetic and are a separate category from cloned-voice audio.
 */
export function MessageBank() {
  const [items, setItems] = useState<BankedMessage[]>([])
  const [recording, setRecording] = useState(false)
  const [label, setLabel] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const playing = useRef<HTMLAudioElement | null>(null)

  const load = async () => setItems(await db.bank.orderBy('createdAt').reverse().toArray())
  useEffect(() => { load() }, [])

  const start = async () => {
    setErr(null)
    if (!label.trim()) return setErr('Give the message a label first.')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const r = new MediaRecorder(stream)
      chunks.current = []
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunks.current, { type: r.mimeType })
        await db.bank.add({ id: uid(), label: label.trim().slice(0, 80), transcript: '', blob, mime: r.mimeType, createdAt: Date.now() })
        setLabel('')
        await load()
      }
      r.start()
      rec.current = r
      setRecording(true)
    } catch {
      setErr('Microphone permission was denied or unavailable.')
    }
  }
  const stop = () => {
    rec.current?.stop()
    rec.current = null
    setRecording(false)
  }
  const play = (m: BankedMessage) => {
    playing.current?.pause()
    const a = new Audio(URL.createObjectURL(m.blob))
    a.onended = () => URL.revokeObjectURL(a.src)
    playing.current = a
    void a.play()
  }
  const importFile = async (f: File | undefined) => {
    if (!f || !label.trim()) return setErr('Give the message a label, then choose a file.')
    await db.bank.add({ id: uid(), label: label.trim().slice(0, 80), transcript: '', blob: f, mime: f.type, createdAt: Date.now() })
    setLabel('')
    await load()
  }

  return (
    <section id="message-bank" aria-labelledby="bank-h" className="rv-panel p-4">
      <h2 id="bank-h" className="mb-1 text-lg font-bold">Message bank</h2>
      <p className="rv-muted mb-3 text-sm">Your own original recordings. Stored only on this device and playable offline.</p>
      <ul className="mb-3 grid gap-2 sm:grid-cols-2" role="list">
        {items.map((m) => (
          <li key={m.id} className="flex gap-2">
            <button data-scan className="rv-btn flex-1 justify-start" onClick={() => play(m)}>▶ {m.label}</button>
            <button className="rv-btn rv-btn-danger" aria-label={`Delete recording ${m.label}`} onClick={async () => { await db.bank.delete(m.id); await load() }}>✕</button>
          </li>
        ))}
        {items.length === 0 && <li className="rv-muted text-sm">No recordings yet.</li>}
      </ul>
      <div className="flex flex-wrap gap-2">
        <label className="flex-1"><span className="sr-only">Recording label</span>
          <input className="rv-input w-full" maxLength={80} placeholder="Label, e.g. 'Love you, kiddo'" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        {recording ? <button className="rv-btn rv-btn-danger" onClick={stop}>■ Stop recording</button> : <button className="rv-btn" onClick={start}>● Record</button>}
        <label className="rv-btn cursor-pointer">Import file<input type="file" accept="audio/*" className="sr-only" onChange={(e) => importFile(e.target.files?.[0])} /></label>
      </div>
      {err && <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--warn)' }}>{err}</p>}
    </section>
  )
}
