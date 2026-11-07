'use client'
import { useCallback, useEffect, useState } from 'react'
import { getPref, setPref } from '@/lib/client/db'
import type { OutputLanguage } from '@/lib/contracts'
import { DEFAULT_VOICE_ID } from '@/lib/voices'
import { DEFAULT_AUTO_TURN, clampSilenceMs, clampVetoMs, isIntentPref, type IntentPref } from '@/lib/turn-taking'

export interface Prefs {
  textScale: number
  targetRem: number
  highContrast: boolean
  reducedMotion: boolean
  scanning: boolean
  scanIntervalMs: number
  confirmBeforeSpeak: boolean
  outputLanguage: OutputLanguage
  inputLanguages: string[]
  voiceId: string
  keyterms: string[]
  contextPrompt: string
  styleCard: string
  aiSuggestions: boolean
  /** Explicit opt-in to use the device/system voice when the cloud voice is unavailable. */
  deviceVoiceFallback: boolean
  /** "Hold My Turn" phrase — shown verbatim on the button; pressing it approves exactly this text. */
  holdTurnPhrase: string
  /** Partner session mode preference. */
  sessionMode: 'tabletop' | 'partner-link' | 'remote'
  /** Optional user-selected third intent for the Intent Compass. */
  preferredIntent: string
  /**
   * Auto turn-taking (OFF by default; a standing, revocable delegation with a visible veto window — see src/lib/turn-taking.ts).
   * silence 1.5–3.0 s before the app drafts; veto window 2–10 s before the chosen reply is spoken.
   */
  autoTurn: boolean
  autoSilenceMs: number
  autoVetoMs: number
  autoIntent: IntentPref
}

export const DEFAULT_PREFS: Prefs = {
  textScale: 1,
  targetRem: 3.25,
  highContrast: false,
  reducedMotion: false,
  scanning: false,
  scanIntervalMs: 1500,
  confirmBeforeSpeak: false,
  outputLanguage: 'english',
  inputLanguages: ['en'],
  voiceId: DEFAULT_VOICE_ID,
  keyterms: [],
  contextPrompt: '',
  styleCard: '',
  aiSuggestions: true,
  deviceVoiceFallback: true,
  holdTurnPhrase: 'I have something to add.',
  sessionMode: 'tabletop',
  preferredIntent: '',
  autoTurn: DEFAULT_AUTO_TURN.enabled,
  autoSilenceMs: DEFAULT_AUTO_TURN.silenceMs,
  autoVetoMs: DEFAULT_AUTO_TURN.vetoMs,
  autoIntent: DEFAULT_AUTO_TURN.intent,
}

/** Stored prefs from older versions (or hand-edited) must never switch auto turn-taking on or leave a bound out of range. */
export function sanitizePrefs(p: Partial<Prefs>): Prefs {
  const m = { ...DEFAULT_PREFS, ...p }
  return { ...m, autoTurn: p.autoTurn === true, autoSilenceMs: clampSilenceMs(m.autoSilenceMs), autoVetoMs: clampVetoMs(m.autoVetoMs), autoIntent: isIntentPref(m.autoIntent) ? m.autoIntent : 'auto' }
}

export type SyncState = { state: 'local' | 'synced' | 'syncing' | 'error'; message?: string; at?: number }

/**
 * NO SIGN-IN: preferences live on this device (IndexedDB) and nowhere else. There is no cloud copy to sync, merge or
 * retry, so `sync` is always `local` (kept in the return shape so the Settings panel needs no special case).
 */
export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [loaded, setLoaded] = useState(false)
  const sync: SyncState = { state: 'local' }

  useEffect(() => {
    getPref<Partial<Prefs>>('prefs', {}).then((p) => {
      setPrefs(sanitizePrefs(p))
      setLoaded(true)
    })
  }, [])

  // Apply accessibility settings to the document.
  useEffect(() => {
    const h = document.documentElement
    h.style.setProperty('--text-scale', String(prefs.textScale))
    h.style.setProperty('--target', `${prefs.targetRem}rem`)
    h.dataset.contrast = prefs.highContrast ? 'high' : 'normal'
    h.dataset.motion = prefs.reducedMotion ? 'reduced' : 'normal'
  }, [prefs.textScale, prefs.targetRem, prefs.highContrast, prefs.reducedMotion])

  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = sanitizePrefs({ ...p, ...patch })
      void setPref('prefs', next)
      return next
    })
  }, [])

  return { prefs, update, loaded, sync }
}
