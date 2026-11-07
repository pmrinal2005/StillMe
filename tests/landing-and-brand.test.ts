/**
 * Landing-first flow + StillMe brand + Vercel config.
 * Static checks (no browser): the landing is "/", the dashboard moved to "/dashboard", every CTA points at the dashboard,
 * the landing needs no third-party scripts (CSP script-src is 'self'), the offline shell knows both pages, and the
 * logo/icon/manifest files exist and agree.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildCsp } from '../src/lib/csp'

const root = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')
const exists = (f: string) => fs.existsSync(path.join(root, f))

describe('landing first, then the dashboard', () => {
  it('"/" renders the landing page and "/dashboard" renders the app', () => {
    expect(read('src/app/page.tsx')).toMatch(/Landing/)
    expect(read('src/app/page.tsx')).not.toMatch(/ReVoiceApp/)
    expect(read('src/app/dashboard/page.tsx')).toMatch(/<ReVoiceApp \/>/)
  })

  it('every landing call to action enters /dashboard', () => {
    const landing = read('src/components/landing/Landing.tsx')
    const reveal = read('src/components/landing/RevealStage.tsx')
    // header button + hero primary + footer link, and both reveal buttons
    expect((landing.match(/href="\/dashboard"/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect((reveal.match(/href="\/dashboard"/g) ?? []).length).toBe(2)
    expect(landing).toMatch(/router\.push\('\/dashboard'\)/)
    expect(landing).toMatch(/Open Dashboard/)
  })

  it('the dashboard links back to the landing page', () => {
    expect(read('src/components/ReVoiceApp.tsx')).toMatch(/href="\/"[^>]*className="rv-brand"/)
  })

  it('the landing adds no CDN script, hotlinked video or external stylesheet (CSP stays script-src self)', () => {
    const files = ['src/components/landing/Landing.tsx', 'src/components/landing/RevealStage.tsx', 'src/components/landing/OrbitImages.tsx', 'src/components/landing/landing.css', 'src/app/page.tsx']
    for (const f of files) {
      const s = read(f)
      expect(s, f).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
      expect(s, f).not.toMatch(/next\/script|<video|cloudfront|unpkg|jsdelivr/)
    }
    expect(buildCsp({ dev: false })).toMatch(/script-src 'self' 'unsafe-inline' blob:/)
  })

  it('orbit images exist and are original local SVGs', () => {
    for (let i = 1; i <= 6; i++) expect(exists(`public/images/orbit-${i}.svg`), `orbit-${i}`).toBe(true)
    expect(read('src/components/landing/OrbitImages.tsx')).not.toMatch(/\.jpg/)
  })

  it('respects reduced motion and offers a skip link', () => {
    expect(read('src/components/landing/landing.css')).toMatch(/prefers-reduced-motion: reduce/)
    expect(read('src/components/landing/Landing.tsx')).toMatch(/Skip to content/)
  })
})

describe('offline shell and PWA', () => {
  it('service worker caches landing, dashboard and join under separate keys and has a fresh cache name', () => {
    const sw = read('public/sw.js')
    expect(sw).toMatch(/SHELL = \[[^\]]*'\/'[^\]]*'\/dashboard'[^\]]*'\/join'/)
    expect(sw).toMatch(/startsWith\('\/dashboard'\)/)
    expect(sw).toMatch(/stillme-shell-v4/)
  })
  it('manifest is StillMe and starts at the dashboard', () => {
    const m = JSON.parse(read('public/manifest.webmanifest'))
    expect(m.name).toBe('StillMe')
    expect(m.start_url).toBe('/dashboard')
    for (const i of m.icons) expect(exists(`public${i.src}`), i.src).toBe(true)
  })
})

describe('StillMe brand assets', () => {
  it('logo, icons, favicon and social card exist', () => {
    for (const f of ['logo.svg', 'logo.png', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon.ico', 'og.png']) expect(exists(`public/${f}`), f).toBe(true)
    const ico = fs.readFileSync(path.join(root, 'public/favicon.ico'))
    expect(ico.readUInt16LE(2)).toBe(1)
  })
  it('tagline and name are used in metadata', () => {
    const page = read('src/app/page.tsx')
    expect(page).toMatch(/Still me\. Still speaking\./)
    expect(read('src/app/layout.tsx')).toMatch(/applicationName: 'StillMe'/)
    expect(read('src/components/ui/BrandMark.tsx')).toMatch(/BRAND_TAGLINE = 'Still me\. Still speaking\.'/)
  })
})

describe('vercel.json', () => {
  const v = JSON.parse(read('vercel.json'))
  it('is a Next.js project with a reproducible install, API duration and no-store API', () => {
    expect(v.framework).toBe('nextjs')
    expect(v.installCommand).toBe('npm ci')
    expect(v.buildCommand).toBe('npm run build')
    expect(v.functions['src/app/api/**/route.ts'].maxDuration).toBeLessThanOrEqual(300)
    expect(v.headers.find((h: { source: string }) => h.source === '/api/(.*)').headers).toContainEqual({ key: 'Cache-Control', value: 'no-store' })
  })
  it('does not override the Next.js output directory, and keeps the purge cron', () => {
    expect(v.outputDirectory).toBeUndefined()
    expect(v.crons[0].path).toBe('/api/cron/purge')
  })
  it('package-lock is in sync enough for npm ci (motion is a declared dependency)', () => {
    expect(JSON.parse(read('package.json')).dependencies.motion).toBeTruthy()
    expect(read('package-lock.json')).toMatch(/node_modules\/motion"/)
  })
})
