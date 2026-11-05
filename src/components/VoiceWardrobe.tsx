'use client'
import { useEffect, useState } from 'react'
import { db, purgeVoiceCache, syncVoicesFromServer, uid, type ConsentEvent } from '@/lib/client/db'
import { api, ApiError } from '@/lib/client/api'
import {
  CONSENT_PERIOD_DAYS,
  LIBRARY_VOICES,
  libraryVoicesFor,
  clonedVoiceUsable,
  consentExpiry,
  isLibraryVoice,
  type ClonedVoiceProfile,
} from '@/lib/voices'
import { OUTPUT_LANGUAGES, type OutputLanguage } from '@/lib/contracts'
import { OUTPUT_LANGUAGE_LABELS } from '@/lib/languages'

export const RENEW_AFFIRMATION = 'I consent to renew use of my synthetic voice'

const fmt = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
const daysLeft = (ms: number) => Math.ceil((ms - Date.now()) / 86_400_000)

/**
 * Voice wardrobe = authorized voice choices (library voices + registered cloned voices).
 *
 * Cloned voices are created ONLY in the AssemblyAI dashboard (record/upload → consent → biometric terms).
 * This panel sends provenance and explicit consent to the SERVER registry (B11), which records it, shows a Voice Identity Card with expiry, requires a
 * typed affirmation for renewal, and disables revoked/expired voices with an explicit fallback.
 */
export function VoiceWardrobe(props: {
  voiceId: string
  outputLanguage: OutputLanguage
  region: 'us' | 'eu'
  onSelect: (voiceId: string) => void
  onVoicesChanged?: () => void
}) {
  const { voiceId, outputLanguage, region } = props
  const [clones, setClones] = useState<ClonedVoiceProfile[]>([])
  const [history, setHistory] = useState<ConsentEvent[]>([])
  const [onboarding, setOnboarding] = useState(false)
  const [renewFor, setRenewFor] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const load = async () => {
    // B11: the SERVER registry is the source of truth; the browser copy is only a display cache of it.
    try {
      const r = await api.voicesList()
      await syncVoicesFromServer(r.voices)
    } catch (e) {
      // Guests / signed-out users have no registry: any cloned voice cached on this device is not authorized.
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) await syncVoicesFromServer([])
      // Any other failure (offline): keep the cache for display; the server still re-checks every use.
    }
    setClones(await db.voices.toArray())
    setHistory(await db.consentLog.orderBy('at').reverse().limit(20).toArray())
    props.onVoicesChanged?.()
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const libraryForLang = libraryVoicesFor(outputLanguage)

  const revoke = async (v: ClonedVoiceProfile) => {
    if (!confirm(`Revoke "${v.label}"? It will no longer be usable in ReVOICE. Delete it in the AssemblyAI dashboard to remove it from the provider.`)) return
    try {
      // B11: revocation is recorded server-side first, so no device can keep using the clone.
      await api.voiceRevoke(v.voiceId)
    } catch (e) {
      setMsg(e instanceof ApiError ? `Could not revoke: ${e.code}` : 'Could not revoke. Check your connection and try again.')
      return
    }
    await db.voices.update(v.id, { revoked: true })
    await db.consentLog.add({ id: uid(), voiceRecordId: v.id, action: 'revocation', at: Date.now() })
    await purgeVoiceCache(v.voiceId)
    if (voiceId === v.voiceId) props.onSelect(v.fallbackVoiceId)
    setMsg(`Revoked. Switched to fallback voice.`)
    await load()
  }

  return (
    <section id="voice-wardrobe" aria-labelledby="voice-h" className="rv-glass rv-enter p-4 sm:p-6">
      <h2 id="voice-h" className="rv-section-title mb-2">Voice wardrobe</h2>
      <p className="rv-muted mb-3 text-sm">
        All voices are synthetic. Changing voice or language starts a newly configured voice connection. There are no pitch, speed, or emotion controls — use your style card for writing style.
      </p>
      {msg && <p role="status" className="mb-2 text-sm rv-text-ok">{msg}</p>}

      <fieldset className="mb-4">
        <legend className="mb-1 font-semibold">Library voices ({OUTPUT_LANGUAGE_LABELS[outputLanguage]})</legend>
        {libraryForLang.length === 0 && <p className="rv-muted text-sm">No library voice is listed for this language yet; any listed voice can be tried, quality may vary.</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {(libraryForLang.length ? libraryForLang : LIBRARY_VOICES).map((v) => (
            <label key={v.id} className="rv-mode text-sm">
              <input type="radio" name="voice" checked={voiceId === v.id} onChange={() => props.onSelect(v.id)} />
              <span><strong>{v.name}</strong> <span className="rv-muted">— {v.description}</span></span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 font-semibold">Your authorized cloned voices</legend>
        {clones.length === 0 && <p className="rv-muted text-sm">None registered.</p>}
        <ul className="grid gap-3" role="list">
          {clones.map((v) => {
            const u = clonedVoiceUsable(v, region)
            const exp = consentExpiry(v)
            return (
              <li key={v.id} className="rv-panel p-4" aria-label={`Voice Identity Card: ${v.label}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>{v.label}</strong>
                  <span className={`rv-badge ${u.ok ? (u.remindRenewal ? 'rv-badge-warn' : 'rv-badge-ok') : 'rv-badge-danger'}`}>
                    {u.ok ? (u.remindRenewal ? `Renew soon — ${daysLeft(exp)} days left` : 'Usable') : `Disabled: ${u.reason.replace(/_/g, ' ')}`}
                  </span>
                </div>
                {/* Voice Identity Card */}
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <dt className="rv-muted">Status</dt><dd>Synthetic voice (clone)</dd>
                  <dt className="rv-muted">Authorized owner</dt><dd>{v.ownerName}</dd>
                  <dt className="rv-muted">Recording language</dt><dd>{OUTPUT_LANGUAGE_LABELS[v.recordingLanguage]}</dd>
                  <dt className="rv-muted">Region</dt><dd>{v.region.toUpperCase()}{v.region !== region && ' (does not match server region)'}</dd>
                  <dt className="rv-muted">Sample provenance</dt><dd>{v.provenance}{v.provenanceNote ? ` — ${v.provenanceNote}` : ''}</dd>
                  <dt className="rv-muted">Consent given</dt><dd>{fmt(v.consentAt)}</dd>
                  <dt className="rv-muted">Consent expires</dt><dd>{fmt(exp)}{v.providerExpiresAt ? ' (provider-reported)' : ' (estimated)'}</dd>
                  <dt className="rv-muted">Fallback voice</dt><dd>{LIBRARY_VOICES.find((l) => l.id === v.fallbackVoiceId)?.name ?? v.fallbackVoiceId}</dd>
                </dl>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button className="rv-btn text-sm" disabled={!u.ok} aria-pressed={voiceId === v.voiceId} onClick={() => props.onSelect(v.voiceId)}>
                    {voiceId === v.voiceId ? 'Selected' : 'Use this voice'}
                  </button>
                  {!v.revoked && <button className="rv-btn text-sm" onClick={() => setRenewFor(v.id)}>Renew consent…</button>}
                  {!v.revoked && <button className="rv-btn rv-btn-danger text-sm" onClick={() => revoke(v)}>Revoke</button>}
                </div>
                {renewFor === v.id && <RenewForm voice={v} onDone={async (m) => { setRenewFor(null); setMsg(m); await load() }} />}
              </li>
            )
          })}
        </ul>
        <button className="rv-btn mt-3" onClick={() => setOnboarding((o) => !o)} aria-expanded={onboarding}>
          {onboarding ? 'Cancel registration' : 'Register a cloned voice…'}
        </button>
        {onboarding && <CloneOnboarding region={region} onDone={async () => { setOnboarding(false); setMsg('Cloned voice registered. Run a quality check before using it in conversation.'); await load() }} />}
      </fieldset>

      {history.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer font-semibold">Consent history (on this device)</summary>
          <ul className="mt-2">
            {history.map((h) => (
              <li key={h.id}>{fmt(h.at)} — {h.action} — {clones.find((c) => c.id === h.voiceRecordId)?.label ?? 'deleted voice'}</li>
            ))}
          </ul>
        </details>
      )}
      {!isLibraryVoice(voiceId) && !clones.some((c) => c.voiceId === voiceId) && (
        <p role="alert" className="rv-alert rv-alert-warn mt-2 text-sm">The selected voice is not registered to your account; select a library voice.</p>
      )}
    </section>
  )
}

/** Supervised onboarding wizard. The clone itself is created in the AssemblyAI dashboard (no API clone-creation endpoint). */
function CloneOnboarding({ region, onDone }: { region: 'us' | 'eu'; onDone: () => void }) {
  const [step, setStep] = useState(1)
  const [f, setF] = useState({
    voiceId: '', label: '', ownerName: '', recordingLanguage: 'english' as OutputLanguage,
    provenance: 'self-recorded' as ClonedVoiceProfile['provenance'], provenanceNote: '',
    speakerConsent: false, rightsConfirmed: false, biometricTermsAccepted: false,
    fallbackVoiceId: 'aai-audrey', qualityChecked: false, region,
  })
  const [err, setErr] = useState<string | null>(null)
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }))

  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!f.voiceId.trim() || !f.label.trim() || !f.ownerName.trim()) return setErr('Voice ID, label and owner name are required.')
    if (!f.speakerConsent || !f.rightsConfirmed || !f.biometricTermsAccepted) return setErr('All three consent confirmations are required.')
    if (!f.qualityChecked) return setErr('Confirm the owner reviewed a quality sample.')
    setBusy(true)
    setErr(null)
    try {
      // B11: the SERVER records the consent (with its own timestamp), verifies the voice exists with the provider in this
      // data zone and binds the voice id to this ONE account. Nothing is saved on the device unless that succeeds.
      const r = await api.voiceRegister({
        voiceId: f.voiceId.trim(), label: f.label.trim(), ownerName: f.ownerName.trim(), recordingLanguage: f.recordingLanguage,
        provenance: f.provenance, provenanceNote: f.provenanceNote, fallbackVoiceId: f.fallbackVoiceId,
        qualityChecked: true, speakerConsent: true, rightsConfirmed: true, biometricTermsAccepted: true,
      })
      await db.voices.put(r.voice)
      await db.consentLog.add({ id: uid(), voiceRecordId: r.voice.id, action: 'initial', at: r.voice.consentAt })
      onDone()
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'error'
      const msg: Record<string, string> = {
        account_required: 'Sign in with an account to register a cloned voice.',
        voice_claimed: 'This voice id is already registered to another account.',
        voice_tombstoned: 'This voice belonged to a deleted account and cannot be registered.',
        voice_not_found: 'AssemblyAI does not know this voice id in this data zone. Create it in the dashboard first.',
        registration_not_allowed: 'This deployment restricts who may register cloned voices.',
        rate_limited: 'Too many attempts. Try again later.',
        voice_registry_migration_required: 'The server database needs migration 0004 before cloned voices can be registered.',
      }
      setErr(msg[code] ?? `Registration failed (${code}).`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rv-panel mt-3 grid gap-3 p-4" role="group" aria-label="Cloned voice registration">
      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Steps">
        {['Create in dashboard', 'Provenance', 'Consent', 'Register & check'].map((s, i) => (
          <li key={s} aria-current={step === i + 1 ? 'step' : undefined} className={step === i + 1 ? 'rv-badge rv-badge-brand' : 'rv-badge'}>{i + 1}. {s}</li>
        ))}
      </ol>
      {step === 1 && (
        <div className="text-sm">
          <p>Create the clone in the <strong>AssemblyAI dashboard</strong> (Text-to-speech → Voices → Clone) using the documented record/upload workflow:</p>
          <ul className="ml-5 list-disc">
            <li>10–30 seconds of clear speech from a single speaker; WAV preferred over compressed audio.</li>
            <li>An old voicemail is a <em>possible</em> source only if it is clear, single-speaker, and you hold the rights and consent.</li>
            <li>Create it in the <strong>{region.toUpperCase()}</strong> data zone — cloned voices only work in the zone they were created in.</li>
            <li>ReVOICE never stores the voice sample.</li>
          </ul>
          <button className="rv-btn rv-btn-primary mt-2" onClick={() => setStep(2)}>I created it — next</button>
        </div>
      )}
      {step === 2 && (
        <div className="grid gap-2 text-sm">
          <label className="grid">Where did the sample come from?
            <select className="rv-input" value={f.provenance} onChange={(e) => set({ provenance: e.target.value as ClonedVoiceProfile['provenance'] })}>
              <option value="self-recorded">Recorded by the speaker for this purpose</option>
              <option value="voicemail">Existing voicemail / message</option>
              <option value="other-recording">Other existing recording</option>
            </select>
          </label>
          <label className="grid">Provenance note (optional, no personal health details)
            <input className="rv-input" maxLength={300} value={f.provenanceNote} onChange={(e) => set({ provenanceNote: e.target.value })} />
          </label>
          <label className="grid">Recording language
            <select className="rv-input" value={f.recordingLanguage} onChange={(e) => set({ recordingLanguage: e.target.value as OutputLanguage })}>
              {OUTPUT_LANGUAGES.map((l) => <option key={l} value={l}>{OUTPUT_LANGUAGE_LABELS[l]}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-2"><button className="rv-btn" onClick={() => setStep(1)}>Back</button><button className="rv-btn rv-btn-primary" onClick={() => setStep(3)}>Next</button></div>
        </div>
      )}
      {step === 3 && (
        <div className="grid gap-2 text-sm">
          <label className="flex gap-2"><input type="checkbox" checked={f.speakerConsent} onChange={(e) => set({ speakerConsent: e.target.checked })} /> The person whose voice this is has personally consented to a synthetic copy being made and used by them in ReVOICE.</label>
          <label className="flex gap-2"><input type="checkbox" checked={f.rightsConfirmed} onChange={(e) => set({ rightsConfirmed: e.target.checked })} /> We have the rights to use this recording for this purpose.</label>
          <label className="flex gap-2"><input type="checkbox" checked={f.biometricTermsAccepted} onChange={(e) => set({ biometricTermsAccepted: e.target.checked })} /> The applicable AssemblyAI biometric terms were accepted. Consent lasts {CONSENT_PERIOD_DAYS} days unless affirmatively renewed.</label>
          <p className="rv-muted">Consent to cloning is separate from consent to processing a conversation, saving a recap, or sharing content.</p>
          <div className="flex flex-wrap gap-2"><button className="rv-btn" onClick={() => setStep(2)}>Back</button><button className="rv-btn rv-btn-primary" onClick={() => setStep(4)}>Next</button></div>
        </div>
      )}
      {step === 4 && (
        <div className="grid gap-2 text-sm">
          <label className="grid">AssemblyAI voice ID<input className="rv-input" maxLength={128} value={f.voiceId} onChange={(e) => set({ voiceId: e.target.value })} /></label>
          <label className="grid">Label<input className="rv-input" maxLength={80} value={f.label} onChange={(e) => set({ label: e.target.value })} /></label>
          <label className="grid">Authorized owner (the speaker)<input className="rv-input" maxLength={80} value={f.ownerName} onChange={(e) => set({ ownerName: e.target.value })} /></label>
          <label className="grid">Explicit fallback voice (used if this clone is disabled)
            <select className="rv-input" value={f.fallbackVoiceId} onChange={(e) => set({ fallbackVoiceId: e.target.value })}>
              {LIBRARY_VOICES.map((v) => <option key={v.id} value={v.id}>{v.name} ({OUTPUT_LANGUAGE_LABELS[v.language]})</option>)}
            </select>
          </label>
          <label className="flex gap-2"><input type="checkbox" checked={f.qualityChecked} onChange={(e) => set({ qualityChecked: e.target.checked })} /> The owner listened to a sample in the dashboard and approves its quality.</label>
          {err && <p role="alert" className="rv-text-danger">{err}</p>}
          <div className="flex flex-wrap gap-2"><button className="rv-btn" onClick={() => setStep(3)}>Back</button><button className="rv-btn rv-btn-primary" disabled={busy} onClick={save}>{busy ? 'Registering…' : 'Register voice'}</button></div>
        </div>
      )}
    </div>
  )
}

/** Affirmative renewal: the owner types an exact phrase. Consent is never extended silently or automatically. */
function RenewForm({ voice, onDone }: { voice: ClonedVoiceProfile; onDone: (msg: string) => void }) {
  const [typed, setTyped] = useState('')
  const [owner, setOwner] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await api.renewConsent(voice.voiceId, typed, voice.recordingLanguage) // A9: explicit language
      const now = Date.now()
      await db.voices.put(r.voice ?? { ...voice, consentAt: now, providerExpiresAt: r.providerExpiresAt ?? undefined, speakerConsent: true })
      await db.consentLog.add({ id: uid(), voiceRecordId: voice.id, action: 'renewal', at: now })
      onDone(`Consent renewed. New expiry: ${fmt(r.providerExpiresAt ?? now + CONSENT_PERIOD_DAYS * 86_400_000)}.`)
    } catch (e) {
      setErr(e instanceof ApiError ? `Renewal failed: ${e.code}` : 'Renewal failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-2 grid gap-2 text-sm" role="group" aria-label="Renew consent">
      <label className="flex gap-2"><input type="checkbox" checked={owner} onChange={(e) => setOwner(e.target.checked)} /> I am {voice.ownerName}, the speaker, and I am renewing this myself.</label>
      <label className="grid">Type exactly: <code>{RENEW_AFFIRMATION}</code>
        <input className="rv-input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </label>
      {err && <p role="alert" className="rv-text-danger">{err}</p>}
      <button className="rv-btn rv-btn-primary" disabled={busy || !owner || typed !== RENEW_AFFIRMATION} onClick={submit}>Renew consent</button>
      <p className="rv-muted">Renewal sends one tiny (billed) synthesis request with the provider’s documented renewal flag.</p>
    </div>
  )
}
