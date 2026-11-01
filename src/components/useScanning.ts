'use client'
import { useEffect, useRef } from 'react'

/**
 * Single-switch auto-scanning. Highlights each enabled [data-scan] control in DOM order;
 * the switch (mapped to Space or Enter, as most USB/Bluetooth switch interfaces do) selects it.
 * Works alongside OS-level switch control / eye-gaze tools, which drive normal focus & click.
 * Never intercepts keys while the user is typing in a text field.
 */
export function useScanning(enabled: boolean, intervalMs: number) {
  const idx = useRef(-1)
  useEffect(() => {
    if (!enabled) return
    const items = () => Array.from(document.querySelectorAll<HTMLElement>('[data-scan]')).filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null)
    let current: HTMLElement | null = null
    const step = () => {
      const list = items()
      if (!list.length) return
      current?.classList.remove('rv-scan-focus')
      idx.current = (idx.current + 1) % list.length
      current = list[idx.current]
      current.classList.add('rv-scan-focus')
      current.scrollIntoView({ block: 'nearest' })
    }
    const t = setInterval(step, Math.max(600, intervalMs))
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return
      if ((e.key === ' ' || e.key === 'Enter') && current) {
        e.preventDefault()
        current.click()
        idx.current = -1 // restart from the top after a selection
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearInterval(t)
      window.removeEventListener('keydown', onKey)
      current?.classList.remove('rv-scan-focus')
    }
  }, [enabled, intervalMs])
}
