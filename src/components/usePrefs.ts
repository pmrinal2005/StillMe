'use client'
import { useCallback, useEffect, useState } from 'react'
import { getPref, setPref } from '@/lib/client/db'
import { getSupabase } from '@/lib/client/supabase'
import type { OutputLanguage } from '@/lib/contracts'
import { DEFAULT_VOICE_ID } from '@/lib/voices'

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
}

/** Preferences live on-device (IndexedDB). If signed in to Supabase, accessibility + style sync via RLS. */
export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    getPref<Partial<Prefs>>('prefs', {}).then((p) => {
      setPrefs({ ...DEFAULT_PREFS, ...p })
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
      const next = { ...p, ...patch }
      void setPref('prefs', next)
      void syncRemote(next)
      return next
    })
  }, [])

  return { prefs, update, loaded }
}

let syncTimer: ReturnType<typeof setTimeout> | null = null
async function syncRemote(p: Prefs) {
  const sb = getSupabase()
  if (!sb) return
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(async () => {
    const { data } = await sb.auth.getUser()
    const uid = data.user?.id
    if (!uid) return
    await sb.from('accessibility_prefs').upsert({
      user_id: uid,
      text_scale: p.textScale,
      target_rem: p.targetRem,
      high_contrast: p.highContrast,
      reduced_motion: p.reducedMotion,
      scanning: p.scanning,
      scan_interval_ms: p.scanIntervalMs,
      confirm_before_speak: p.confirmBeforeSpeak,
      input_languages: p.inputLanguages,
      output_language: p.outputLanguage,
      updated_at: new Date().toISOString(),
    })
    await sb.from('style_cards').upsert({ user_id: uid, style: p.styleCard.slice(0, 600), keyterms: p.keyterms.slice(0, 30), context_prompt: p.contextPrompt.slice(0, 300), updated_at: new Date().toISOString() })
  }, 1200)
}
