'use client'
import { useCallback } from 'react'

export type PhraseSyncState = { state: 'local' | 'synced' | 'syncing' | 'error'; message?: string; at?: number }

const LOCAL: PhraseSyncState = { state: 'local' }

/**
 * NO SIGN-IN: phrase boards are stored on this device only (IndexedDB, works offline). There is no cloud copy, so there
 * is nothing to sync; the hook keeps its old shape so the boards component is unchanged. `onChanged` is accepted for the
 * same reason and is never called.
 */
export function usePhraseSync(_onChanged?: () => void) {
  const schedule = useCallback(() => undefined, [])
  const syncNow = useCallback(async () => undefined, [])
  return { sync: LOCAL, schedule, syncNow }
}
