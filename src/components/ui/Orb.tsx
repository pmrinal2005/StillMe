/**
 * The ReVOICE "liquid glass" orb — a purely decorative, CSS-only status visual.
 * Its state mirrors (never replaces) the text status: listening ripples, drafting shimmer,
 * speaking pulse, holding dashed ring, offline grey. Motion stops under reduced-motion.
 */
import { BrandMark } from './BrandMark'

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
      <BrandMark size={size} />
    </span>
  )
}
