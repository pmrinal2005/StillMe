import { useId } from 'react'

/**
 * The StillMe mark: the iridescent voice orb with a single "S" stroke (a voice line that bends but never breaks)
 * and a spark dot. Inline SVG so it inherits crisp rendering at any size and needs no extra request.
 */
export function BrandMark({ size = 40, title }: { size?: number; title?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const o = `bm-o-${uid}`
  const s = `bm-s-${uid}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      style={{ display: 'block', flex: 'none' }}
    >
      <defs>
        <radialGradient id={o} cx="35%" cy="28%" r="75%">
          <stop offset="0" stopColor="#fff" />
          <stop offset=".22" stopColor="#ffc4e6" />
          <stop offset=".58" stopColor="#e07bd2" />
          <stop offset=".84" stopColor="#b98af0" />
          <stop offset="1" stopColor="#6fd8e8" />
        </radialGradient>
        <linearGradient id={s} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b2a86" />
          <stop offset="1" stopColor="#3d1a6e" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill={`url(#${o})`} />
      <ellipse cx="24" cy="16.5" rx="12.5" ry="6" fill="#fff" opacity=".55" />
      <path
        d="M41 21C41 14 23 14 23 23C23 32 41 31 41 41C41 50 23 50 23 43"
        fill="none"
        stroke={`url(#${s})`}
        strokeWidth="5.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="47.5" cy="17.5" r="2.7" fill="#fff" />
    </svg>
  )
}

export const BRAND_NAME = 'StillMe'
export const BRAND_TAGLINE = 'Still me. Still speaking.'
