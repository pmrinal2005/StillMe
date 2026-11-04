'use client'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * B9 — rail tooltips that can never be covered or clipped.
 *
 * Bug: the tooltip was an absolutely positioned child of the rail button. The rail's <nav> uses
 * `backdrop-filter` (glass) and the <aside> is `position: sticky`; both create stacking contexts,
 * so the tip's `z-index: 60` only applied INSIDE the rail. The <main> canvas (also backdrop-filter +
 * position: relative) comes later in the DOM and painted over it, so "Voice" showed as "Vo…".
 *
 * Fix: one shared tooltip rendered through a portal into <body> with `position: fixed`, positioned
 * from the trigger's bounding box and clamped to the viewport. No ancestor stacking context, overflow
 * or border can affect it. Dismissible with Escape (WCAG 1.4.13), hover-persistent, never steals focus,
 * and only used where the visible label is hidden (desktop rail).
 */
export interface TipState {
  label: string
  rect: { top: number; left: number; right: number; bottom: number; height: number }
}

export function computeTipPosition(rect: TipState['rect'], tip: { width: number; height: number }, viewport: { width: number; height: number }, gap = 10) {
  let left = rect.right + gap
  let placement: 'right' | 'left' = 'right'
  if (left + tip.width > viewport.width - 4) {
    left = Math.max(4, rect.left - gap - tip.width)
    placement = 'left'
  }
  const top = Math.min(Math.max(4, rect.top + rect.height / 2 - tip.height / 2), Math.max(4, viewport.height - tip.height - 4))
  return { top, left, placement }
}

export function useFloatingTip() {
  const [tip, setTip] = useState<TipState | null>(null)
  const show = useCallback((label: string, el: HTMLElement) => {
    // Visible labels are shown below lg (tab bar), so the tooltip is desktop-rail only.
    if (typeof window !== 'undefined' && window.matchMedia && !window.matchMedia('(min-width: 1024px)').matches) return
    const r = el.getBoundingClientRect()
    setTip({ label, rect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom, height: r.height } })
  }, [])
  const hide = useCallback(() => setTip(null), [])

  useEffect(() => {
    if (!tip) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTip(null) }
    const onMove = () => setTip(null)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [tip])

  /** Props to spread on a trigger. */
  const bind = useCallback((label: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(label, e.currentTarget),
    onMouseLeave: hide,
    onFocus: (e: React.FocusEvent<HTMLElement>) => { if (e.currentTarget.matches(':focus-visible')) show(label, e.currentTarget) },
    onBlur: hide,
  }), [show, hide])

  return { tip, bind, hide }
}

export function FloatingTip({ tip }: { tip: TipState | null }) {
  const [mounted, setMounted] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'right' | 'left' } | null>(null)
  useEffect(() => setMounted(true), [])
  // Measure synchronously before paint, then place (no flicker, no hidden state left behind).
  useLayoutEffect(() => {
    if (!tip || !ref.current) { setPos(null); return }
    const r = ref.current.getBoundingClientRect()
    setPos(computeTipPosition(tip.rect, { width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight }))
  }, [tip, mounted])
  if (!mounted || !tip) return null
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      id="rv-floating-tip"
      className="rv-floating-tip"
      data-placement={pos?.placement ?? 'right'}
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
    >
      {tip.label}
    </div>,
    document.body,
  )
}
