'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { dexiePhraseStore } from '@/lib/client/db'
import { getSupabase } from '@/lib/client/supabase'
import { runPhraseSync, type PhraseRemote } from '@/lib/phrase-sync'
import type { SupabaseClient } from '@supabase/supabase-js'

export type PhraseSyncState = { state: 'local' | 'synced' | 'syncing' | 'error'; message?: string; at?: number }

function remoteFor(sb: SupabaseClient): PhraseRemote {
  return {
    fetchBoards: async () => {
      const r = await sb.from('phrase_boards').select('*').limit(5000)
      return { rows: r.data ?? [], error: r.error }
    },
    fetchPhrases: async () => {
      const r = await sb.from('phrases').select('*').limit(5000)
      return { rows: r.data ?? [], error: r.error }
    },
    upsertBoards: async (rows) => (await sb.from('phrase_boards').upsert(rows, { onConflict: 'id' })).error,
    upsertPhrases: async (rows) => (await sb.from('phrases').upsert(rows, { onConflict: 'id' })).error,
  }
}

/**
 * E48: two-way phrase-board sync (last-writer-wins per row, soft deletes). Boards stay fully usable offline / signed out;
 * sync runs on sign-in, when the tab becomes visible, when the network returns, and (debounced) after a local edit.
 * Failures are surfaced (`state: 'error'`) and retried — never silently dropped. `onChanged` fires after cloud rows were merged in.
 */
export function usePhraseSync(onChanged: () => void) {
  const [sync, setSync] = useState<PhraseSyncState>({ state: 'local' })
  const running = useRef(false)
  const again = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const changed = useRef(onChanged)
  changed.current = onChanged

  const run = useCallback(async () => {
    const sb = getSupabase()
    if (!sb) return
    if (running.current) { again.current = true; return } // coalesce: run once more after the current pass
    running.current = true
    try {
      const { data } = await sb.auth.getUser()
      const user = data.user
      if (!user || user.is_anonymous) { setSync({ state: 'local' }); return }
      setSync((s) => ({ ...s, state: 'syncing' }))
      try {
        const r = await runPhraseSync({ store: dexiePhraseStore, remote: remoteFor(sb), userId: user.id })
        if (r.pulled > 0) changed.current()
        setSync(r.ok ? { state: 'synced', at: Date.now() } : { state: 'error', message: r.message, at: Date.now() })
      } catch (e) {
        setSync({ state: 'error', message: `Phrases could not be synced (${(e as Error).message?.slice(0, 80) ?? 'error'}). They are kept on this device.`, at: Date.now() })
      }
    } finally {
      running.current = false
      if (again.current) { again.current = false; void run() }
    }
  }, [])

  useEffect(() => {
    const sb = getSupabase()
    if (!sb) return
    void run()
    const { data: sub } = sb.auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_IN' || evt === 'USER_UPDATED') void run() })
    const onVis = () => { if (document.visibilityState === 'visible') void run() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', onVis)
    return () => {
      sub.subscription.unsubscribe()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onVis)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [run])

  /** Call after any local mutation. */
  const schedule = useCallback(() => {
    if (!getSupabase()) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void run(), 1500)
  }, [run])

  return { sync, schedule, syncNow: run }
}
