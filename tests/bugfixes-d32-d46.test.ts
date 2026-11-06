/**
 * Regression tests for the D-series (Medium: auth, session and client), bugs #32-#46.
 * Each describe block names the bug it pins. Worker-side #45 lives in worker/tests/test_d45_call_room_cleanup.py.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { planExistingSessions } from '@/lib/session-replace'
import { AssemblyError, isNetworkFailure, parseVoiceExpiryMs, providerFailure, sanitizeProviderCode } from '@/lib/server/assemblyai'
import { adoptProviderExpiry, fallbackVoiceFor, LIBRARY_VOICES } from '@/lib/voices'
import { ctrlEnterAction, elapsedMinutes, heldApprovalExpired, HOLD_EXPIRY_SLACK_MS } from '@/lib/shortcuts'
import { SpeechController, MAX_HOLD_MS, type PlayerLike, type SpeechDeps } from '@/lib/client/speech'
import { decodePcm16le, PcmStreamPlayer, trimOldest } from '@/lib/client/pcm-player'
import { CAPTURE_WORKLET_SRC, createDownsampler, naiveDecimate } from '@/lib/client/downsample'
import { phoneMonthUsedDurable, monthKey, rv } from '@/lib/server/state'
import type { Approval } from '@/lib/contracts'
import { sha256Hex } from '@/lib/hash'
import { signed } from './helpers'

const root = path.resolve(__dirname, '..')

// ---------------------------------------------------------------------------------------------- #32 - #34 (replaced)
// These three bugs were about Supabase token verification, the guest fallback and session recovery. There is no sign-in any
// more, so the whole class of problem is gone. What replaces them is pinned here.
describe('D #32-#34 (superseded) — no tokens, no verification round-trip, no guest fallback, no recovery loop', () => {
  const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')

  it('the server never calls an identity provider: resolving the caller is a local HMAC check', () => {
    const src = read('src/lib/server/auth.ts')
    expect(src).not.toMatch(/@supabase\/supabase-js|createClient|\.auth\./)
    expect(src).toMatch(/parseDeviceKey\(jar\.get\(DEVICE_COOKIE\)\?\.value\)/)
  })

  it('every client request goes through authedFetch, which sends the cookie and the optional local secrets and NEVER retries', () => {
    const src = read('src/lib/client/api.ts')
    expect(src).not.toMatch(/\bfetch\('\/api/)
    expect(src).not.toMatch(/authorization|Bearer|refreshSession|recoverAuth|x-revoice-expect-account/)
    expect(src).toMatch(/credentials: 'same-origin'/)
  })

  it('the old auth modules and routes are gone', () => {
    for (const f of ['src/lib/server/auth-note.ts', 'src/lib/auth-providers.ts', 'src/lib/client/supabase.ts', 'src/components/AuthControls.tsx', 'src/lib/prefs-sync.ts']) {
      expect(fs.existsSync(path.join(root, f)), f).toBe(false)
    }
  })

  it('no source file imports or mentions a sign-in provider, token or account tier', () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const offenders: string[] = []
    for (const f of walk(path.join(root, 'src')).filter((x) => /\.(ts|tsx)$/.test(x))) {
      const code = strip(fs.readFileSync(f, 'utf8'))
      if (/signInWith|signOut|onAuthStateChange|getSession\(|auth\.getUser|requireAccount|account_required|AuthControls|isGuest|kind: 'guest'|'local-demo'|is_anonymous|@supabase\/ssr/.test(code)) offenders.push(path.relative(root, f))
    }
    expect(offenders).toEqual([])
  })

  it('the browser bundle never imports the Supabase client (the database is server-side only)', () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    const clientFiles = walk(path.join(root, 'src')).filter((f) => /\.(ts|tsx)$/.test(f) && /^['"]use client['"]/.test(fs.readFileSync(f, 'utf8')))
    expect(clientFiles.length).toBeGreaterThan(5)
    for (const f of clientFiles) expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/@supabase\/supabase-js/)
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.dependencies['@supabase/ssr']).toBeUndefined()
  })

  it('NEXT_PUBLIC_SUPABASE_* is not needed by the browser and the CSP no longer allows Supabase origins', async () => {
    const { buildCsp } = await import('@/lib/csp')
    expect(buildCsp({ livekitUrl: 'wss://x.livekit.cloud' })).not.toMatch(/supabase/)
    expect(read('.env.example')).not.toMatch(/NEXT_PUBLIC_SUPABASE|ANON_KEY|OAUTH|GITHUB|GOOGLE/i)
  })
})

// ---------------------------------------------------------------------------------------------- #35
describe('D #35 — replace never silently ends another device\'s session', () => {
  it('no existing room → none', () => expect(planExistingSessions([], false)).toEqual({ action: 'none' }))
  it('own stale room (ticket presented) is replaced without a prompt', () => {
    expect(planExistingSessions([{ room: 'rv-a', mine: true }], false)).toEqual({ action: 'replace', rooms: ['rv-a'] })
  })
  it('another device\'s room is a conflict until the caller consents', () => {
    expect(planExistingSessions([{ room: 'rv-a', mine: false }], false)).toEqual({ action: 'conflict', room: 'rv-a', otherDevice: true })
    expect(planExistingSessions([{ room: 'rv-a', mine: false }], true)).toEqual({ action: 'replace', rooms: ['rv-a'] })
  })
  it('mixed own + foreign: conflict names the FOREIGN room', () => {
    const plan = planExistingSessions([{ room: 'rv-own', mine: true }, { room: 'rv-other', mine: false }], false)
    expect(plan).toEqual({ action: 'conflict', room: 'rv-other', otherDevice: true })
  })
  it('the client no longer sends replace:true unconditionally and asks first', () => {
    const src = fs.readFileSync(path.join(root, 'src/components/ReVoiceApp.tsx'), 'utf8')
    expect(src).not.toMatch(/startSession\(\{[^}]*replace: true \}\)\s*\n\s*(?:\/\/|if)/)
    expect(src).toMatch(/replace: false/)
    expect(src).toMatch(/window\.confirm\(/)
  })
})

// ---------------------------------------------------------------------------------------------- #36
describe('D #36 (superseded) — there is no Sign out to leave a billed session running', () => {
  const src = fs.readFileSync(path.join(root, 'src/components/ReVoiceApp.tsx'), 'utf8')
  it('the header has no sign-in / sign-out control', () => {
    expect(src).not.toMatch(/AuthControls|onBeforeSignOut|Sign out|Sign in/)
  })
  it('a listening session still ends on page hide / explicit end, and settles by ticket (unchanged)', () => {
    expect(src).toMatch(/endSession/)
  })
})

// ---------------------------------------------------------------------------------------------- #37
describe('D #37 — speak route error mapping', () => {
  const E = (status: number, code: string, retryAfter?: number) => new AssemblyError(status, code, status >= 500, retryAfter)

  it('a provider 401/403 is OUR 502 speech_provider_auth — never a 401 the UI reads as "sign in"', () => {
    for (const s of [401, 403]) {
      const f = providerFailure(E(s, 'unauthorized'))
      expect(f.status).toBe(502)
      expect(f.body.error).toBe('speech_provider_auth')
      expect(f.body.retryable).toBe(false)
    }
  })
  it('an auth-shaped CODE on a non-401 status is still mapped away from 401', () => {
    expect(providerFailure(E(400, 'invalid_api_key')).body.error).toBe('speech_provider_auth')
  })
  it('402 → provider_credit_exhausted; 429 → rate_limited with Retry-After', () => {
    expect(providerFailure(E(402, 'payment_required'))).toMatchObject({ status: 402, body: { error: 'provider_credit_exhausted' } })
    expect(providerFailure(E(429, 'whatever', 7))).toMatchObject({ status: 429, retryAfter: 7, body: { error: 'rate_limited', retryable: true } })
  })
  it('bad voice/text → 422 with a safe code; 5xx/network → 502', () => {
    expect(providerFailure(E(422, 'voice_not_found'))).toMatchObject({ status: 422, body: { error: 'voice_not_found' } })
    expect(providerFailure(E(400, 'Bad Code!')).body.error).toBe('bad_code_')
    expect(providerFailure(E(500, 'boom')).status).toBe(502)
    expect(providerFailure(E(0, 'network_error')).status).toBe(502)
  })
  it('the only 401s our app emits are its own', () => {
    for (let s = 400; s < 600; s++) expect(providerFailure(E(s, 'x')).status).not.toBe(401)
  })
  it('sanitizeProviderCode never lets an auth-shaped code through', () => {
    expect(sanitizeProviderCode('Unauthorized', 'fb')).toBe('fb')
    expect(sanitizeProviderCode('', 'fb')).toBe('fb')
    expect(sanitizeProviderCode(undefined, 'fb')).toBe('fb')
    expect(sanitizeProviderCode('rate-limit hit', 'fb')).toBe('rate_limit_hit')
  })
  it('a network-level failure is a retryable 502, not a generic 500 (found by the live check on the deployed site)', () => {
    expect(isNetworkFailure(new TypeError('fetch failed'))).toBe(true)
    expect(isNetworkFailure(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isNetworkFailure(Object.assign(new Error('x'), { cause: { code: 'UND_ERR_SOCKET' } }))).toBe(true)
    expect(isNetworkFailure(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false) // Stop is not a failure
    expect(isNetworkFailure(new Error('logic bug'))).toBe(false) // real bugs stay visible as 500s
    expect(isNetworkFailure('str')).toBe(false)
    const src = fs.readFileSync(path.join(root, 'src/app/api/speak/route.ts'), 'utf8')
    expect(src).toMatch(/isNetworkFailure\(e\)[\s\S]*speech_provider_unreachable[\s\S]*502/)
  })
  it('an internal 500 names the exception CLASS (diagnosable) but never its message', async () => {
    const { withJsonErrors } = await import('@/lib/server/route')
    const res = await withJsonErrors('t', async () => { throw new RangeError('secret user text') })()
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body.kind).toBe('RangeError')
    expect(JSON.stringify(body)).not.toContain('secret user text')
  })
  it('the speak route uses providerFailure', () => {
    expect(fs.readFileSync(path.join(root, 'src/app/api/speak/route.ts'), 'utf8')).toMatch(/providerFailure\(e\)/)
  })
})

// ---------------------------------------------------------------------------------------------- #38
describe('D #38 — expiry units (provider header is epoch SECONDS)', () => {
  it('seconds are converted to milliseconds', () => expect(parseVoiceExpiryMs('1800000000')).toBe(1_800_000_000_000))
  it('an already-millisecond value is not multiplied again', () => expect(parseVoiceExpiryMs('1800000000000')).toBe(1_800_000_000_000))
  it('absent / junk / non-positive → undefined', () => {
    for (const v of [null, undefined, '', 'abc', '0', '-5']) expect(parseVoiceExpiryMs(v as string | null)).toBeUndefined()
  })
  it('adoptProviderExpiry only takes a plausible future date that differs by >1 min', () => {
    const now = 1_000_000
    expect(adoptProviderExpiry(undefined, now + 86_400_000, now)).toBe(now + 86_400_000)
    expect(adoptProviderExpiry(now + 86_400_000, now + 86_400_000 + 30_000, now)).toBeUndefined() // not rewritten per utterance
    expect(adoptProviderExpiry(now + 86_400_000, now + 2 * 86_400_000, now)).toBe(now + 2 * 86_400_000)
    expect(adoptProviderExpiry(undefined, now - 1, now)).toBeUndefined() // past
    expect(adoptProviderExpiry(undefined, undefined, now)).toBeUndefined()
    expect(adoptProviderExpiry(undefined, Number.NaN, now)).toBeUndefined()
  })
  it('both the route and the renew route share the same conversion', () => {
    expect(fs.readFileSync(path.join(root, 'src/lib/server/assemblyai.ts'), 'utf8')).toMatch(/voiceExpiresAt: parseVoiceExpiryMs\(/)
    expect(fs.readFileSync(path.join(root, 'src/app/api/voices/renew/route.ts'), 'utf8')).toMatch(/parseVoiceExpiryMs\(/)
  })
})

// ---------------------------------------------------------------------------------------------- #39
describe('D #39 — fallback voice speaks the OUTPUT language', () => {
  it('every supported language gets a voice of that language', () => {
    for (const lang of ['english', 'spanish', 'german', 'italian', 'french', 'portuguese'] as const) {
      const id = fallbackVoiceFor(lang)
      expect(LIBRARY_VOICES.find((v) => v.id === id)?.language).toBe(lang)
    }
  })
  it('keeps the owner\'s chosen fallback only when it speaks the language', () => {
    expect(fallbackVoiceFor('english', 'aai-peter')).toBe('aai-peter')
    expect(fallbackVoiceFor('spanish', 'aai-peter')).not.toBe('aai-peter')
    expect(fallbackVoiceFor('spanish', 'aai-peter')).toBe('aai-constanza')
  })
  it('an unknown preferred id is ignored', () => expect(fallbackVoiceFor('german', 'nope')).toBe('aai-jorg'))
})

// ---------------------------------------------------------------------------------------------- #40
describe('D #40 — hold expiry uses durations, not the device clock vs the server clock', () => {
  const approval = { iat: 5_000_000_000_000, exp: 5_000_000_000_000 + 60_000 } // server timeline, far from the device clock
  it('ignores a device clock that is minutes off the server', () => {
    const heldAt = 1_000_000 // device timeline: nowhere near the server timestamps
    expect(heldApprovalExpired(approval, heldAt, heldAt + 10_000, MAX_HOLD_MS)).toBe(false) // clock "behind": used to be expired at once? no — used to be spoken after refusal
    expect(heldApprovalExpired({ iat: 1, exp: 1 + 60_000 }, heldAt, heldAt + 10_000, MAX_HOLD_MS)).toBe(false) // clock "ahead" of server: used to expire immediately
  })
  it('expires when the held duration exceeds the approval\'s own lifetime (minus slack)', () => {
    const heldAt = 0
    expect(heldApprovalExpired(approval, heldAt, 60_000 - HOLD_EXPIRY_SLACK_MS + 1, 10 * 60_000)).toBe(true)
    expect(heldApprovalExpired(approval, heldAt, 60_000 - HOLD_EXPIRY_SLACK_MS - 1, 10 * 60_000)).toBe(false)
  })
  it('expires at the hold cap', () => {
    const long = { iat: 0, exp: 10 * 60 * 60_000 }
    expect(heldApprovalExpired(long, 0, MAX_HOLD_MS + 1, MAX_HOLD_MS)).toBe(true)
    expect(heldApprovalExpired(long, 0, MAX_HOLD_MS - 1, MAX_HOLD_MS)).toBe(false)
  })

  class P implements PlayerLike {
    async unlock() {}
    begin() {}
    push() {}
    async drained() {}
    stop() {}
  }
  it('SpeechController: a phone with a wrong clock can still release a fresh held message', async () => {
    let device = 7_000_000 // device clock unrelated to the server stamps inside the approval
    const spoken: string[] = []
    const deps: SpeechDeps = {
      sha256: sha256Hex,
      approve: async (text: string) => signed(text, { now: 1_700_000_000_000 }), // server clock is 1.7e12; device is 7e6
      directStream: async (_a: Approval, text: string) => {
        spoken.push(text)
        return { body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4)); c.close() } }), sampleRate: 24000 }
      },
      player: new P(),
      onState: () => undefined,
      now: () => device,
    }
    const c = new SpeechController(deps)
    expect(await c.request('Hold me', { partnerSpeaking: true })).toBe('held')
    device += 5_000
    expect(await c.gap()).not.toBe('expired')
    expect(spoken).toEqual(['Hold me'])
  })
  it('SpeechController: a message held longer than its lifetime is refused, never spoken', async () => {
    let device = 7_000_000
    const spoken: string[] = []
    const deps: SpeechDeps = {
      sha256: sha256Hex,
      approve: async (text: string) => signed(text, { now: 1_700_000_000_000 }),
      directStream: async (_a: Approval, text: string) => {
        spoken.push(text)
        return { body: new ReadableStream<Uint8Array>({ start(c) { c.close() } }), sampleRate: 24000 }
      },
      player: new P(),
      onState: () => undefined,
      now: () => device,
    }
    const c = new SpeechController(deps)
    await c.request('Too late', { partnerSpeaking: true })
    device += MAX_HOLD_MS + 1
    expect(await c.gap()).toBe('expired')
    expect(spoken).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------- #41
describe('D #41 — Ctrl/Cmd+Enter cannot bypass the confirmation dialog', () => {
  it('inert while the confirmation is open', () => expect(ctrlEnterAction({ confirming: true, text: 'hi', requestInFlight: false })).toBe('ignore'))
  it('inert while a request is already in flight (no double request)', () => expect(ctrlEnterAction({ confirming: false, text: 'hi', requestInFlight: true })).toBe('ignore'))
  it('inert with nothing to say', () => {
    expect(ctrlEnterAction({ confirming: false, text: '   ', requestInFlight: false })).toBe('ignore')
    expect(ctrlEnterAction({ confirming: false, text: '', requestInFlight: false })).toBe('ignore')
  })
  it('speaks otherwise', () => expect(ctrlEnterAction({ confirming: false, text: 'hello', requestInFlight: false })).toBe('speak'))
})

// ---------------------------------------------------------------------------------------------- #42
describe('D #42 — minute counter', () => {
  it('floors to whole minutes, never negative, capped', () => {
    expect(elapsedMinutes(0, 59_999)).toBe(0)
    expect(elapsedMinutes(0, 60_000)).toBe(1)
    expect(elapsedMinutes(10_000, 0)).toBe(0) // clock stepped back
    expect(elapsedMinutes(0, 99 * 60_000, 20)).toBe(20)
  })
  it('the component ticks a clock while a session is active and clears it afterwards', () => {
    const src = fs.readFileSync(path.join(root, 'src/components/ReVoiceApp.tsx'), 'utf8')
    expect(src).toMatch(/setInterval\(\(\) => setClock\(Date\.now\(\)\), 15_000\)/)
    expect(src).toMatch(/return \(\) => clearInterval\(t\)/)
    expect(src).toMatch(/elapsedMinutes\(session\.startedAt, clock, session\.maxMinutes\)/)
  })
})

// ---------------------------------------------------------------------------------------------- #43
describe('D #43 — pcm player alignment and bounded cancelled list', () => {
  const pcm = [0, 1, -1, 32767, -32768, 1234]
  const le = () => {
    const b = new Uint8Array(pcm.length * 2)
    const dv = new DataView(b.buffer)
    pcm.forEach((v, i) => dv.setInt16(i * 2, v, true))
    return b
  }
  it('decodes an even-aligned chunk', () => {
    const out = new Float32Array(pcm.length)
    expect(decodePcm16le(le(), out)).toBe(pcm.length)
    expect(Array.from(out)).toEqual(pcm.map((v) => v / 32768))
  })
  it('decodes a chunk starting at an ODD byte offset (an Int16Array view would throw RangeError here)', () => {
    const data = le()
    const backing = new Uint8Array(data.length + 3)
    backing.set(data, 1) // odd offset
    const view = backing.subarray(1, 1 + data.length)
    expect(() => new Int16Array(view.buffer, view.byteOffset, view.length / 2)).toThrow(RangeError) // the old code path
    const out = new Float32Array(pcm.length)
    expect(decodePcm16le(view, out)).toBe(pcm.length)
    expect(Array.from(out)).toEqual(pcm.map((v) => v / 32768))
  })
  it('ignores a trailing odd byte and never overruns the output', () => {
    const out = new Float32Array(2)
    expect(decodePcm16le(new Uint8Array([1, 0, 2, 0, 9]), out)).toBe(2)
    expect(decodePcm16le(new Uint8Array([1]), out)).toBe(0)
  })
  it('trimOldest keeps only the newest entries', () => {
    const s = new Set<number>()
    for (let i = 0; i < 100; i++) {
      s.add(i)
      trimOldest(s, 32)
    }
    expect(s.size).toBe(32)
    expect([...s][0]).toBe(68)
    expect(s.has(99)).toBe(true)
    expect(s.has(0)).toBe(false)
  })
  it('the cancelled cap exists and is used by the player', () => {
    expect(PcmStreamPlayer.MAX_CANCELLED).toBe(32)
    expect(fs.readFileSync(path.join(root, 'src/lib/client/pcm-player.ts'), 'utf8')).toMatch(/trimOldest\(this\.cancelled, PcmStreamPlayer\.MAX_CANCELLED\)/)
  })
})

// ---------------------------------------------------------------------------------------------- #44
describe('D #44 — worklet downsampler is low-pass filtered', () => {
  const IN = 48_000
  const OUT = 16_000
  const tone = (hz: number, seconds: number) => Float32Array.from({ length: IN * seconds }, (_, i) => Math.sin((2 * Math.PI * hz * i) / IN) * 0.8)
  const rms = (a: Float32Array, skip = 400) => {
    let s = 0
    for (let i = skip; i < a.length; i++) s += a[i] * a[i]
    return Math.sqrt(s / (a.length - skip))
  }
  const feed = (ds: { push(i: Float32Array): Float32Array }, x: Float32Array) => {
    const out: number[] = []
    for (let i = 0; i < x.length; i += 128) out.push(...ds.push(x.subarray(i, i + 128))) // worklet blocks of 128
    return Float32Array.from(out)
  }

  it('produces the right number of samples (16 kHz)', () => {
    const y = feed(createDownsampler(IN, OUT), tone(440, 1))
    expect(y.length).toBeGreaterThan(OUT - 200)
    expect(y.length).toBeLessThanOrEqual(OUT)
  })
  it('passes speech-band content (1 kHz) at ~unity gain', () => {
    const y = feed(createDownsampler(IN, OUT), tone(1000, 1))
    expect(rms(y)).toBeGreaterThan(0.8 * 0.707 * 0.95)
    expect(rms(y)).toBeLessThan(0.8 * 0.707 * 1.05)
  })
  it('suppresses an 11 kHz tone that naive decimation folds INTO the speech band as 5 kHz', () => {
    const x = tone(11_000, 1)
    const naive = rms(naiveDecimate(x, IN, OUT))
    const good = rms(feed(createDownsampler(IN, OUT), x))
    expect(naive).toBeGreaterThan(0.5) // the old worklet: full-strength alias
    expect(good).toBeLessThan(0.05) // filtered
    expect(good).toBeLessThan(naive / 10)
  })
  it('is block-size independent (streaming across worklet blocks equals one big push)', () => {
    const x = tone(700, 0.5)
    const a = feed(createDownsampler(IN, OUT), x)
    const b = createDownsampler(IN, OUT).push(x)
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) expect(a[i]).toBeCloseTo(b[i], 5)
  })
  it('works for 44.1 kHz and does not touch audio when no reduction is needed', () => {
    const y = createDownsampler(44_100, OUT).push(Float32Array.from({ length: 4410 }, (_, i) => Math.sin((2 * Math.PI * 500 * i) / 44_100)))
    expect(y.length).toBeGreaterThan(1400)
    const same = createDownsampler(16_000, OUT).push(Float32Array.from([0.1, 0.2, 0.3]))
    expect(Array.from(same).map((v) => +v.toFixed(2))).toEqual([0.1, 0.2, 0.3])
  })
  it('the shipped worklet source embeds exactly the tested Downsampler and registers the processor', () => {
    expect(CAPTURE_WORKLET_SRC).toContain('class Downsampler')
    expect(CAPTURE_WORKLET_SRC).toContain("registerProcessor('rv-capture'")
    expect(CAPTURE_WORKLET_SRC).toContain('new Downsampler(sampleRate, 16000)')
    expect(fs.readFileSync(path.join(root, 'src/lib/client/listening.ts'), 'utf8')).toMatch(/CAPTURE_WORKLET_SRC/)
  })
})

// ---------------------------------------------------------------------------------------------- #46
describe('D #46 — phone minutes come from the durable store (instance memory is only a floor)', () => {
  beforeEach(() => {
    rv().phoneMinutes.clear()
    rv().phoneReservations.clear()
  })
  const now = Date.parse('2026-11-15T12:00:00Z')

  it('a cold instance (0 local) still sees what other instances recorded', async () => {
    expect(await phoneMonthUsedDurable(now, async () => 31)).toBe(31)
  })
  it('never under-counts: a call this instance knows but the database has not seen yet still counts', async () => {
    rv().phoneMinutes.set(monthKey(now), 12)
    expect(await phoneMonthUsedDurable(now, async () => 5)).toBe(12)
  })
  it('falls back to the instance figure when the durable read is unavailable or throws', async () => {
    rv().phoneMinutes.set(monthKey(now), 7)
    expect(await phoneMonthUsedDurable(now, async () => null)).toBe(7)
    expect(await phoneMonthUsedDurable(now, async () => { throw new Error('db down') })).toBe(7)
  })
  it('outstanding local reservations count too', async () => {
    rv().phoneReservations.set('rv-x:id', { minutes: 10, month: monthKey(now), userId: 'u', at: now })
    expect(await phoneMonthUsedDurable(now, async () => 3)).toBe(10)
  })
  it('the pair, bind and reconcile routes all use the durable total', () => {
    for (const f of ['src/app/api/phone/pair/route.ts', 'src/app/api/phone/bind/route.ts', 'src/app/api/reconcile/route.ts']) {
      const src = fs.readFileSync(path.join(root, f), 'utf8')
      expect(src, f).toMatch(/phoneMonthUsedDurable/)
      expect(src, f).not.toMatch(/\bphoneMonthUsed\(/)
    }
  })
})

// ---------------------------------------------------------------------------------------------- deploy config
describe('vercel.json', () => {
  const v = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'))
  it('is a Next.js project with a reproducible install and the standard build', () => {
    expect(v.framework).toBe('nextjs')
    expect(v.installCommand).toBe('npm ci')
    expect(v.buildCommand).toBe('npm run build')
  })
  it('API functions fit Hobby limits (<= 300 s) and API responses are never cached', () => {
    expect(v.functions['src/app/api/**/route.ts'].maxDuration).toBeLessThanOrEqual(300)
    const api = v.headers.find((h: { source: string }) => h.source === '/api/(.*)')
    expect(api.headers).toContainEqual({ key: 'Cache-Control', value: 'no-store' })
  })
  it('service worker is revalidated and allowed at scope /', () => {
    const sw = v.headers.find((h: { source: string }) => h.source === '/sw.js')
    expect(sw.headers).toContainEqual({ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' })
    expect(sw.headers).toContainEqual({ key: 'Service-Worker-Allowed', value: '/' })
  })
  it('the matched function glob really matches existing routes, and no Cloudflare/Hono is used', () => {
    expect(fs.existsSync(path.join(root, 'src/app/api/speak/route.ts'))).toBe(true)
    const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8')
    expect(pkg).not.toMatch(/hono|wrangler|cloudflare/i)
    expect(fs.existsSync(path.join(root, 'wrangler.jsonc'))).toBe(false)
  })
})
