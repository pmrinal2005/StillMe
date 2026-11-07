'use client'
import { useState } from 'react'
import type { Prefs } from './usePrefs'
import { INPUT_LANGUAGES, OUTPUT_LANGUAGES, type OutputLanguage } from '@/lib/contracts'
import { INPUT_LANGUAGE_LABELS, OUTPUT_LANGUAGE_LABELS, hasNoSpokenOutput } from '@/lib/languages'

/**
 * Accessibility + conversation preferences. Input language (what the partner may speak) and
 * spoken-output language (what ReVOICE can say) are deliberately separate controls.
 */
export function SettingsPanel({ prefs, update }: { prefs: Prefs; update: (p: Partial<Prefs>) => void }) {
  const [kt, setKt] = useState('')
  const addKeyterm = () => {
    const t = kt.trim()
    if (!t || prefs.keyterms.includes(t) || prefs.keyterms.length >= 30) return
    update({ keyterms: [...prefs.keyterms, t.slice(0, 50)] })
    setKt('')
  }
  const toggleInput = (code: string) => {
    const has = prefs.inputLanguages.includes(code)
    const next = has ? prefs.inputLanguages.filter((c) => c !== code) : [...prefs.inputLanguages, code].slice(-4)
    update({ inputLanguages: next })
  }
  const unsupported = prefs.inputLanguages.filter(hasNoSpokenOutput)

  return (
    <section id="settings-panel" aria-labelledby="settings-h" className="rv-glass rv-enter grid gap-5 p-4 sm:p-6">
      <p id="prefs-local-note" className="rv-muted text-xs" role="note">Settings are saved on this device only.</p>
      <header><p className="rv-eyebrow">Access · languages · context</p><h2 id="settings-h" className="rv-section-title">Settings</h2></header>

      <fieldset className="rv-panel grid gap-3 p-4">
        <legend className="rv-badge rv-badge-brand px-3 text-sm">Access</legend>
        <label className="grid text-sm">Text size: {prefs.textScale.toFixed(2)}×
          <input type="range" min={0.75} max={2.5} step={0.05} value={prefs.textScale} onChange={(e) => update({ textScale: Number(e.target.value) })} />
        </label>
        <label className="grid text-sm">Minimum target size: {prefs.targetRem.toFixed(1)} rem
          <input type="range" min={2} max={8} step={0.25} value={prefs.targetRem} onChange={(e) => update({ targetRem: Number(e.target.value) })} />
        </label>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={prefs.highContrast} onChange={(e) => update({ highContrast: e.target.checked })} /> High contrast</label>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={prefs.reducedMotion} onChange={(e) => update({ reducedMotion: e.target.checked })} /> Reduced motion</label>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={prefs.scanning} onChange={(e) => update({ scanning: e.target.checked })} /> Single-switch scanning (switch = Space or Enter)</label>
        {prefs.scanning && (
          <label className="grid text-sm">Scan interval: {(prefs.scanIntervalMs / 1000).toFixed(1)} s
            <input type="range" min={600} max={6000} step={100} value={prefs.scanIntervalMs} onChange={(e) => update({ scanIntervalMs: Number(e.target.value) })} />
          </label>
        )}
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={prefs.confirmBeforeSpeak} onChange={(e) => update({ confirmBeforeSpeak: e.target.checked })} /> Ask me to confirm before speaking</label>
      </fieldset>

      <fieldset className="rv-panel grid gap-3 p-4">
        <legend className="rv-badge rv-badge-brand px-3 text-sm">Languages</legend>
        <label className="grid text-sm">Spoken-output language (what StillMe says)
          <select className="rv-input" value={prefs.outputLanguage} onChange={(e) => update({ outputLanguage: e.target.value as OutputLanguage })}>
            {OUTPUT_LANGUAGES.map((l) => <option key={l} value={l}>{OUTPUT_LANGUAGE_LABELS[l]}</option>)}
          </select>
        </label>
        <details className="text-sm">
          <summary className="cursor-pointer">Partner input languages (what your partner may speak): {prefs.inputLanguages.map((c) => INPUT_LANGUAGE_LABELS[c as keyof typeof INPUT_LANGUAGE_LABELS] ?? c).join(', ') || 'auto'}</summary>
          <div className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-4">
            {INPUT_LANGUAGES.map((c) => (
              <label key={c} className="flex gap-1"><input type="checkbox" checked={prefs.inputLanguages.includes(c)} onChange={() => toggleInput(c)} /> {INPUT_LANGUAGE_LABELS[c]}</label>
            ))}
          </div>
        </details>
        {unsupported.length > 0 && (
          <p className="rv-alert rv-alert-warn text-sm" role="note">
            Your partner may speak {unsupported.map((c) => INPUT_LANGUAGE_LABELS[c as keyof typeof INPUT_LANGUAGE_LABELS]).join(', ')}; ReVOICE can understand it but cannot speak it. Replies are spoken in {OUTPUT_LANGUAGE_LABELS[prefs.outputLanguage]}. Mixed-language (e.g. Hinglish) recognition accuracy is not guaranteed.
          </p>
        )}
      </fieldset>

      <fieldset className="rv-panel grid gap-3 p-4">
        <legend className="rv-badge rv-badge-brand px-3 text-sm">Listening context (you approve every word)</legend>
        <div className="flex flex-wrap gap-1">
          {prefs.keyterms.map((t) => (
            <button key={t} className="rv-badge" aria-label={`Remove keyterm ${t}`} onClick={() => update({ keyterms: prefs.keyterms.filter((x) => x !== t) })}>{t} ✕</button>
          ))}
        </div>
        <label className="flex gap-2 text-sm">
          <span className="sr-only">Add keyterm</span>
          <input className="rv-input flex-1" placeholder="Names or words to recognize (e.g. a friend's name)" value={kt} maxLength={50} onChange={(e) => setKt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addKeyterm()} />
          <button className="rv-btn" onClick={addKeyterm}>Add</button>
        </label>
        <label className="grid text-sm">Short context prompt (optional, no private biography)
          <input className="rv-input" maxLength={300} value={prefs.contextPrompt} onChange={(e) => update({ contextPrompt: e.target.value })} placeholder="e.g. Casual chat at home with family" />
        </label>
      </fieldset>

      <fieldset className="rv-panel grid gap-3 p-4">
        <legend className="rv-badge rv-badge-brand px-3 text-sm">Suggestions</legend>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={prefs.aiSuggestions} onChange={(e) => update({ aiSuggestions: e.target.checked })} /> Show AI-drafted suggestions (Groq). Off = fully manual.</label>
        <label className="grid text-sm">Your style card — how you like to write (not who you are)
          <textarea className="rv-input" rows={3} maxLength={600} value={prefs.styleCard} onChange={(e) => update({ styleCard: e.target.value })} placeholder="e.g. Short sentences. Dry humour. I say 'cheers' instead of 'thanks'." />
        </label>
      </fieldset>

      <fieldset className="rv-panel grid gap-3 p-4">
        <legend className="rv-badge rv-badge-brand px-3 text-sm">Resilience</legend>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={prefs.deviceVoiceFallback} onChange={(e) => update({ deviceVoiceFallback: e.target.checked })} /> Offer the device’s built-in voice when the cloud voice is unavailable</label>
      </fieldset>
    </section>
  )
}
