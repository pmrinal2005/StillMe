/**
 * The ReVOICE "liquid glass" orb — a purely decorative, CSS-only status visual.
 * Its state mirrors (never replaces) the text status: listening ripples, drafting shimmer,
 * speaking pulse, holding dashed ring, offline grey. Motion stops under reduced-motion.
 */
export type OrbState = 'idle' | 'listening' | 'drafting' | 'speaking' | 'holding' | 'alert' | 'offline'

export function Orb({ state = 'idle', size = 200, reflection = true }: { state?: OrbState; size?: number; reflection?: boolean }) {
  return (
    <div className="rv-orb-wrap" data-state={state} aria-hidden="true" style={{ ['--size' as string]: `${size}px` }}>
      <span className="rv-orb-ring" />
      <span className="rv-orb-ring r2" />
      <span className="rv-orb-ring r3" />
      <div className="rv-orb" style={{ ['--size' as string]: `${size}px` }} />
      {reflection && <div className="rv-orb-reflection" />}
    </div>
  )
}

export function Backdrop() {
  return (
    <div className="rv-backdrop" aria-hidden="true">
      <span className="rv-blob b1" />
      <span className="rv-blob b2" />
      <span className="rv-blob b3" />
    </div>
  )
}

export function Logo({ size = 42 }: { size?: number }) {
  return (
    <span className="rv-logo" aria-hidden="true" style={{ width: size, height: size }}>
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke="#5b2a86" strokeWidth="2.4" strokeLinecap="round">
        <path d="M17.5 7.5A7 7 0 1 0 19 13" />
        <path d="M12 9v6M9 11v2M15 11v2" />
      </svg>
    </span>
  )
}
