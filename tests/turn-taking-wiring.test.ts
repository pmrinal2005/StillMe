import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { sanitizePrefs, DEFAULT_PREFS } from '@/components/usePrefs'

const root = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')
const app = read('src/components/ReVoiceApp.tsx')

describe('auto turn-taking preferences', () => {
  it('is OFF by default and old/corrupt stored prefs can never turn it on', () => {
    expect(DEFAULT_PREFS.autoTurn).toBe(false)
    expect(sanitizePrefs({}).autoTurn).toBe(false)
    expect(sanitizePrefs({ autoTurn: 'yes' as unknown as boolean }).autoTurn).toBe(false)
    expect(sanitizePrefs({ autoTurn: true }).autoTurn).toBe(true)
  })
  it('keeps the silence (1.5–3 s) and veto (2–10 s) windows in range, whatever is stored', () => {
    const lo = sanitizePrefs({ autoSilenceMs: 1, autoVetoMs: 1 })
    expect([lo.autoSilenceMs, lo.autoVetoMs]).toEqual([1500, 2000])
    const hi = sanitizePrefs({ autoSilenceMs: 1e9, autoVetoMs: 1e9 })
    expect([hi.autoSilenceMs, hi.autoVetoMs]).toEqual([3000, 10_000])
    expect(sanitizePrefs({ autoIntent: 'bogus' as never }).autoIntent).toBe('auto')
  })
})

describe('auto turn-taking never bypasses the approval path', () => {
  it('the ONLY speech call in the auto path is SpeechController.request (server-signed approval of the exact text)', () => {
    const block = app.slice(app.indexOf('const autoSpeak = useCallback'), app.indexOf('const runAutoAction'))
    expect(block).toMatch(/speech\.request\(cand\.text, \{ source, partnerSpeaking: false, speakNow: true, auto: !viaSayIt \}\)/)
    expect(block).not.toMatch(/api\.speakStream|speakDevice|playerRef|new SpeechSynthesisUtterance|api\.approve/)
  })
  it('"Say it now" is a deliberate human tap (ordinary manual approval, no auto flag); only the timed path carries `auto` for the server backstop', () => {
    expect(app).toMatch(/auto: auto \? \{ mode: 'turn_taking' as const/)
    expect(app).toMatch(/autoSpeak\(a\.pick, a\.viaSayIt\)/)
  })
  it('the words spoken are the picked candidate text verified against the set that was drafted (no rewriting)', () => {
    const block = app.slice(app.indexOf('const autoSpeak = useCallback'), app.indexOf('const runAutoAction'))
    expect(block).toMatch(/cand\.text !== pick\.text/)
    expect(block).toMatch(/proof: d\.set\.proof/)
    expect(block).toMatch(/tracker\.staleness\(d\.set\.turn, d\.text\)/)
  })
  it('a pending automatic reply is cancelled by Stop, by a new session / reconnect, and when the toggle is turned off', () => {
    expect(app).toMatch(/autoCancel\('user_stop'\)/)
    expect(app).toMatch(/autoCancel\('turned_off'\)/)
    expect((app.match(/autoRef\.current\?\.reset\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
  it('turning it on requires an explicit confirmation and AI suggestions to be available', () => {
    const block = app.slice(app.indexOf('const toggleAuto = useCallback'), app.indexOf('// ----------------------------------------------------------------', app.indexOf('const toggleAuto = useCallback')))
    expect(block).toMatch(/window\.confirm\(/)
    expect(block).toMatch(/aiSuggestions/)
    expect(block).toMatch(/providers\.groq/)
  })
  it('the drive loop only runs while listening with the feature switched on, and feeds the owner-presence guards', () => {
    expect(app).toMatch(/if \(!sessionActive \|\| !prefs\.autoTurn\) return/)
    expect(app).toMatch(/composerText: composerValueRef\.current/)
    expect(app).toMatch(/engaged: engage\.current\.active\(now\)/)
  })
  it('the controller is wired to both signals: voice activity and transcript turns', () => {
    expect(app).toMatch(/onVoiceActivity: \(\) => autoRef\.current\?\.partnerActivity\(Date\.now\(\)\)/)
    expect(app).toMatch(/autoRef\.current\?\.partnerTurn\(/)
  })
  it('the turn-taking module itself never touches TTS, the network or the DOM', () => {
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const src = strip(read('src/lib/turn-taking.ts')) + strip(read('src/lib/energy-vad.ts'))
    expect(src).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|document\.|window\.|speechSynthesis|from '\.\/client|api\./)
  })
})

describe('listening is launchable for guests', () => {
  it('browser-direct listening is ON unless explicitly disabled', async () => {
    vi.resetModules()
    for (const [v, expected] of [[undefined, true], ['', true], ['true', true], ['false', false], ['0', false], ['OFF', false]] as const) {
      if (v === undefined) vi.stubEnv('REVOICE_ALLOW_BROWSER_STT', '')
      else vi.stubEnv('REVOICE_ALLOW_BROWSER_STT', v)
      const { env } = await import('@/lib/server/env')
      expect(env.allowBrowserStt(), String(v)).toBe(expected)
      vi.resetModules()
    }
    vi.unstubAllEnvs()
  })
  it('a LiveKit failure or a worker that never joins falls back to direct listening instead of leaving the guest stuck', () => {
    expect(app).toMatch(/switched to direct listening on this device/)
    expect(app).toMatch(/fallbackRef\.current\?\.\('the voice worker did not join'\)/)
    expect(app).toMatch(/fallbackRef\.current\?\.\('no voice worker was available'\)/)
    expect(app).toMatch(/startDirectSession\(\)/)
  })
  it('the Start listening buttons are enabled whenever LiveKit OR direct listening exists (no sign-in anywhere)', () => {
    expect(app).toMatch(/const listenAvailable = !!\(status\?\.providers\.livekit \|\| status\?\.providers\.browserStt\)/)
    expect(app).not.toMatch(/Sign in|sign in|signIn|requireAccount/)
  })
  it('the dead auth modules, routes and env are gone', () => {
    for (const f of ['src/app/api/account', 'src/lib/server/auth-note.ts', 'src/lib/auth-providers.ts', 'src/lib/client/supabase.ts', 'src/components/AuthControls.tsx', 'src/lib/prefs-sync.ts']) {
      expect(fs.existsSync(path.join(root, f)), f).toBe(false)
    }
    expect(read('.env.example')).not.toMatch(/NEXT_PUBLIC_SUPABASE|ANON_KEY/)
    expect(read('.env.example')).toMatch(/REVOICE_ALLOW_BROWSER_STT=true/)
  })
})

describe('deployment config', () => {
  it('vercel.json is a valid Next.js config (no Cloudflare / Hono)', () => {
    const v = JSON.parse(read('vercel.json'))
    expect(v.framework).toBe('nextjs')
    expect(JSON.stringify(v)).not.toMatch(/cloudflare|wrangler|hono/i)
  })
  it('package.json pins a Node engine Vercel supports', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.engines?.node).toMatch(/>=\s*20/)
  })
})
