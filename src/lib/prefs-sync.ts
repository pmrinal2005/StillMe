/**
 * E48/E49: pure merge logic for preference sync (shared by usePrefs and the tests).
 *
 * Before: prefs were only ever UPLOADED (debounced, errors swallowed). A second device never saw them, a sign-in on a fresh
 * browser started from defaults and then overwrote the cloud copy with those defaults on the next change.
 * Now: on sign-in the cloud row is READ BACK and merged (last-writer-wins on updated_at); a failed upload is reported.
 */
export interface RemotePrefsRow {
  text_scale?: number | null
  target_rem?: number | null
  high_contrast?: boolean | null
  reduced_motion?: boolean | null
  scanning?: boolean | null
  scan_interval_ms?: number | null
  confirm_before_speak?: boolean | null
  input_languages?: string[] | null
  output_language?: string | null
  updated_at?: string | null
}
export interface RemoteStyleRow {
  style?: string | null
  keyterms?: string[] | null
  context_prompt?: string | null
  updated_at?: string | null
}

const OUTPUT = ['english', 'spanish', 'german', 'italian', 'portuguese', 'french']
const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined)

/** Map ONLY the synced fields, validating each (the cloud row is untrusted input to the UI). */
export function prefsFromRemote(a: RemotePrefsRow | null | undefined, s: RemoteStyleRow | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (a) {
    const ts = num(a.text_scale, 0.75, 3); if (ts !== undefined) out.textScale = ts
    const tr = num(a.target_rem, 2, 8); if (tr !== undefined) out.targetRem = tr
    if (typeof a.high_contrast === 'boolean') out.highContrast = a.high_contrast
    if (typeof a.reduced_motion === 'boolean') out.reducedMotion = a.reduced_motion
    if (typeof a.scanning === 'boolean') out.scanning = a.scanning
    const si = num(a.scan_interval_ms, 600, 10000); if (si !== undefined) out.scanIntervalMs = si
    if (typeof a.confirm_before_speak === 'boolean') out.confirmBeforeSpeak = a.confirm_before_speak
    if (Array.isArray(a.input_languages) && a.input_languages.every((x) => typeof x === 'string')) out.inputLanguages = a.input_languages.slice(0, 4)
    if (typeof a.output_language === 'string' && OUTPUT.includes(a.output_language)) out.outputLanguage = a.output_language
  }
  if (s) {
    if (typeof s.style === 'string') out.styleCard = s.style.slice(0, 600)
    if (Array.isArray(s.keyterms) && s.keyterms.every((x) => typeof x === 'string')) out.keyterms = s.keyterms.slice(0, 30).map((x) => x.slice(0, 50))
    if (typeof s.context_prompt === 'string') out.contextPrompt = s.context_prompt.slice(0, 300)
  }
  return out
}

/** Newest of the rows' updated_at (ms), 0 when neither has one. */
export function remoteStamp(a: RemotePrefsRow | null | undefined, s: RemoteStyleRow | null | undefined): number {
  return Math.max(a?.updated_at ? Date.parse(a.updated_at) || 0 : 0, s?.updated_at ? Date.parse(s.updated_at) || 0 : 0)
}

export type MergeVerdict = { action: 'adopt-remote'; patch: Record<string, unknown> } | { action: 'keep-local' } | { action: 'push-local' }

/**
 * Last-writer-wins. `localStamp` = when the device last CHANGED a synced pref (0 = never changed: the device only holds defaults).
 *  - no cloud row                     → push local (first sync) — but ONLY if the device actually has user changes;
 *  - cloud newer than the local edit  → adopt the cloud values;
 *  - local edit newer                 → push local.
 * A device that never changed anything (localStamp 0) must never overwrite an existing cloud row with defaults.
 */
export function mergePrefs(local: { stamp: number }, a: RemotePrefsRow | null | undefined, s: RemoteStyleRow | null | undefined): MergeVerdict {
  const rs = remoteStamp(a, s)
  if (!a && !s) return local.stamp > 0 ? { action: 'push-local' } : { action: 'keep-local' }
  if (rs >= local.stamp) return { action: 'adopt-remote', patch: prefsFromRemote(a, s) }
  return { action: 'push-local' }
}
