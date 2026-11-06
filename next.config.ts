import type { NextConfig } from 'next'
import { buildCsp } from './src/lib/csp'

const dev = process.env.NODE_ENV !== 'production'

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  // Microphone is only needed for listening sessions on this origin.
  { key: 'Permissions-Policy', value: 'microphone=(self), camera=(), geolocation=()' },
  // E50: CSP (see src/lib/csp.ts). frame-ancestors duplicates X-Frame-Options for browsers that prefer CSP.
  { key: 'Content-Security-Policy', value: buildCsp({ dev, supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL, livekitUrl: process.env.LIVEKIT_URL }) },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
