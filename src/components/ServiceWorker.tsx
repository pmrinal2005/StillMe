'use client'
import { useEffect } from 'react'

/** Registers the offline shell. Offline = typed composition, phrase boards, message bank, device voice. No cloud AI. */
export function ServiceWorker() {
  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined)
    }
  }, [])
  return null
}
