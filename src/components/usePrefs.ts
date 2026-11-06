'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getPref, setPref } from '@/lib/client/db'
import { getSupabase } from '@/lib/client/supabase'
import type { OutputLanguage } from '@/lib/contracts'
import { DEFAULT_VOICE_ID } from '@/lib/voices'
import { mergePrefs, remoteStamp } from '@/lib/prefs-sync'

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

const SYNCED_KEYS: (keyof Prefs)[] = ['textScale', 'targetRem', 'highContrast', 'reducedMotion', 'scanning', 'scanIntervalMs', 'confirmBeforeSpeak', 'inputLanguages', 'outputLanguage', 'styleCard', 'keyterms', 'contextPrompt']

export type SyncState = { state: 'local' | 'synced' | 'syncing' | 'error'; message?: string; at?: number }

/**
 * Preferences live on-device (IndexedDB). If signed in to Supabase, accessibility + style sync via RLS:
 *  - E48: on sign-in the cloud copy is READ BACK and merged (last-writer-wins) — a second device now sees it;
 *  - E49: a failed upload is SURFACED (`sync.state === 'error'`) and retried on the next change / sign-in / reconnect,
 *    instead of being silently dropped.
 */
export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [loaded, setLoaded] = useState(false)
  const [sync, setSync] = useState<SyncState>({ state: 'local' })
  const stampRef = useRef(0)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  useEffect(() => {
    Promise.all([getPref<Partial<Prefs>>('prefs', {}), getPref<number>('prefs_stamp', 0)]).then(([p, stamp]) => {
      stampRef.current = stamp
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

  const push = useCallback(async (p: Prefs): Promise<boolean> => {
    const sb = getSupabase()
    if (!sb) return true
    const { data } = await sb.auth.getUser()
    const uid = data.user?.id
    if (!uid || data.user?.is_anonymous) return true // guests have no cloud row
    const now = new Date().toISOString()
    const a = await sb.from('accessibility_prefs').upsert({
      user_id: uid, text_scale: p.textScale, target_rem: p.targetRem, high_contrast: p.highContrast, reduced_motion: p.reducedMotion,
      scanning: p.scanning, scan_interval_ms: p.scanIntervalMs, confirm_before_speak: p.confirmBeforeSpeak,
      input_languages: p.inputLanguages, output_language: p.outputLanguage, updated_at: now,
    })
    const st = await sb.from('style_cards').upsert({ user_id: uid, style: p.styleCard.slice(0, 600), keyterms: p.keyterms.slice(0, 30), context_prompt: p.contextPrompt.slice(0, 300), updated_at: now })
    const err = a.error ?? st.error
    if (err) {
      setSync({ state: 'error', message: `Your settings could not be saved to your account (${err.code ?? 'error'}). They are kept on this device and will be retried.`, at: Date.now() })
      return false
    }
    setSync({ state: 'synced', at: Date.now() })
    return true
  }, [])

  /** E48: read the cloud copy back and merge it (last-writer-wins on updated_at). Runs on sign-in and on tab refocus. */
  const pull = useCallback(async () => {
    const sb = getSupabase()
    if (!sb) return
    const { data } = await sb.auth.getUser()
    const uid = data.user?.id
    if (!uid || data.user?.is_anonymous) return
    setSync((s) => ({ ...s, state: 'syncing' }))
    const [a, st] = await Promise.all([
      sb.from('accessibility_prefs').select('*').eq('user_id', uid).maybeSingle(),
      sb.from('style_cards').select('*').eq('user_id', uid).maybeSingle(),
    ])
    if (a.error || st.error) {
      setSync({ state: 'error', message: `Could not read your saved settings (${(a.error ?? st.error)?.code ?? 'error'}). This device keeps its own copy.`, at: Date.now() })
      return
    }
    const verdict = mergePrefs({ stamp: stampRef.current }, a.data, st.data)
    if (verdict.action === 'adopt-remote') {
      const stamp = remoteStamp(a.data, st.data) || Date.now()
      stampRef.current = stamp
      setPrefs((p) => {
        const next = { ...p, ...verdict.patch } as Prefs
        void setPref('prefs', next)
        return next
      })
      void setPref('prefs_stamp', stamp)
      setSync({ state: 'synced', at: Date.now() })
    } else if (verdict.action === 'push-local') {
      await push(prefsRef.current)
    } else setSync({ state: 'synced', at: Date.now() })
  }, [push])

  // Pull on sign-in / token refresh and when the tab becomes visible again.
  useEffect(() => {
    if (!loaded) return
    const sb = getSupabase()
    if (!sb) return
    void pull()
    const { data: sub } = sb.auth.onAuthStateChange((evt) => {
      if (evt === 'SIGNED_IN' || evt === 'USER_UPDATED') void pull()
    })
    const onVis = () => { if (document.visibilityState === 'visible') void pull() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      sub.subscription.unsubscribe()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [loaded, pull])

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch }
      void setPref('prefs', next)
      if (SYNCED_KEYS.some((k) => k in patch)) {
        stampRef.current = Date.now()
        void setPref('prefs_stamp', stampRef.current)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => void push(next), 1200)
      }
      return next
    })
  }, [push])

  /** Retry a failed upload now (also bound to the Settings "Retry" button). */
  const retrySync = useCallback(() => void push(prefsRef.current), [push])

  return { prefs, update, loaded, sync, retrySync }
}
