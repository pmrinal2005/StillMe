/**
 * Regression tests for B7 and the B5/B6 follow-up hardening:
 *  B7a every API route answers JSON on unexpected errors (no empty 500), misconfiguration → 503
 *  B7b the mode radio uses (and persists) the saved sessionMode preference
 *  B7c /favicon.ico exists (no console 404) and is declared in metadata/manifest
 *  B5+ worker leaving mid-utterance never leaves Speak stuck; remote-mode fallback is announced honestly
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyError, withJsonErrors } from '@/lib/server/route'
import { effectiveMode, isSessionMode, modeAvailable } from '@/lib/session-mode'
import { fallbackAudibleToPartner, fallbackNotice } from '@/lib/audio-routing'
import { SpeechController, type PlayerLike, type SpeechDeps } from '@/lib/client/speech'
import type { Approval } from '@/lib/contracts'
import { sha256Hex } from '@/lib/hash'
import { signed } from './helpers'

const root = path.resolve(__dirname, '..')

// ------------------------------------------------------------------ B7a
describe('B7a — JSON error wrapper for all routes', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('an exception becomes a JSON 500 with a request id (was: empty 500)', async () => {
    const h = withJsonErrors('test', async () => {
      throw new Error('boom: secret user text must not leak')
    })
    const res = await h()
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.error).toBe('internal_error')
    expect(body.requestId).toMatch(/^[a-f0-9]{16}$/)
    expect(res.headers.get('x-revoice-request-id')).toBe(body.requestId)
    expect(JSON.stringify(body)).not.toContain('secret user text') // never echoes exception messages
  })

  it('successful responses pass through and get a request id', async () => {
    const h = withJsonErrors('test', async () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }))
    const res = await h()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(res.headers.get('x-revoice-request-id')).toMatch(/^[a-f0-9]{16}$/)
  })

  it('classifies a missing approval secret as 503 server_misconfigured', () => {
    expect(classifyError(new Error('approval_secret_unavailable: set …'))).toMatchObject({ status: 503, error: 'server_misconfigured' })
    expect(classifyError(new Error('LiveKit not configured'))).toMatchObject({ status: 503, error: 'livekit_not_configured' })
    expect(classifyError(new SyntaxError('bad json'))).toMatchObject({ status: 400, error: 'invalid_request' })
    expect(classifyError('weird')).toMatchObject({ status: 500, error: 'internal_error' })
  })

  it('a real route in production with no secret returns JSON 503 instead of crashing', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('REVOICE_APPROVAL_SECRET', '')
    vi.stubEnv('LIVEKIT_API_SECRET', '')
    vi.stubEnv('ASSEMBLYAI_API_KEY', '')
    const { POST } = await import('@/app/api/phone/usage/route')
    const res = await POST(new Request('http://x/api/phone/usage', { method: 'POST', body: '{}', headers: { 'x-revoice-worker': '1.abc' } }))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('server_misconfigured')
  })

  it('EVERY API route exports its handlers through withJsonErrors', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name === 'route.ts') files.push(p)
      }
    }
    walk(path.join(root, 'src/app/api'))
    expect(files.length).toBeGreaterThanOrEqual(15)
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/export async function (GET|POST|PUT|PATCH|DELETE)\b/)
      const methods = [...src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = (\w+)\(/g)]
      expect(methods.length, f).toBeGreaterThan(0)
      for (const m of methods) expect(m[2], f).toBe('withJsonErrors')
    }
  })
})

// ------------------------------------------------------------------ B7b
describe('B7b — mode radio uses the saved preference', () => {
  it('uses the saved mode when the server supports it', () => {
    expect(effectiveMode('partner-link', true)).toBe('partner-link')
    expect(effectiveMode('remote', true)).toBe('remote')
    expect(effectiveMode('tabletop', true)).toBe('tabletop')
  })
  it('falls back to tabletop without LiveKit (saved preference is kept, not overwritten)', () => {
    expect(effectiveMode('partner-link', false)).toBe('tabletop')
    expect(modeAvailable('remote', false)).toBe(false)
    expect(modeAvailable('tabletop', false)).toBe(true)
  })
  it('ignores corrupt stored values', () => {
    expect(effectiveMode('bogus', true)).toBe('tabletop')
    expect(effectiveMode(undefined, true)).toBe('tabletop')
    expect(isSessionMode('remote')).toBe(true)
    expect(isSessionMode(3)).toBe(false)
  })
  it('the session panel no longer hard-codes tabletop state and persists choices', () => {
    const src = fs.readFileSync(path.join(root, 'src/components/ReVoiceApp.tsx'), 'utf8')
    expect(src).not.toMatch(/useState<Mode>\('tabletop'\)/)
    expect(src).toMatch(/effectiveMode\(prefs\.sessionMode/)
    expect(src).toMatch(/update\(\{ sessionMode: m \}\)/)
  })
})

// ------------------------------------------------------------------ B7c
describe('B7c — favicon', () => {
  it('public/favicon.ico is a real ICO file', () => {
    const buf = fs.readFileSync(path.join(root, 'public/favicon.ico'))
    expect(buf.readUInt16LE(0)).toBe(0) // reserved
    expect(buf.readUInt16LE(2)).toBe(1) // type: icon
    expect(buf.readUInt16LE(4)).toBeGreaterThan(0) // image count
  })
  it('metadata and manifest declare the icons', () => {
    const layout = fs.readFileSync(path.join(root, 'src/app/layout.tsx'), 'utf8')
    expect(layout).toContain('/favicon.ico')
    expect(layout).toContain('/apple-touch-icon.png')
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf8'))
    const srcs = manifest.icons.map((i: { src: string }) => i.src)
    for (const s of srcs) expect(fs.existsSync(path.join(root, 'public', s))).toBe(true)
    expect(srcs).toContain('/icon-192.png')
    expect(srcs).toContain('/icon-512.png')
  })
})

// ------------------------------------------------------------------ B5/B6 hardening
class FakePlayer implements PlayerLike {
  async unlock() {}
  begin() {}
  push() {}
  async drained() {}
  stop() {}
}
const pcm = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4)); c.close() } })

function setup() {
  const direct: { text: string; roomName: string | null }[] = []
  const fallbacks: string[] = []
  const room = { speak: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const deps: SpeechDeps = {
    sha256: sha256Hex,
    approve: async (text, _h, _s, route) => signed(text, route === 'direct' ? { over: { roomName: undefined } } : {}),
    directStream: async (a: Approval, text: string) => {
      direct.push({ text, roomName: a.roomName })
      return { body: pcm(), sampleRate: 24000 }
    },
    room,
    route: () => 'room',
    onRouteFallback: (r) => fallbacks.push(r),
    roomAckTimeoutMs: 10_000, // long: the worker-left path must not depend on the ack timer
    player: new FakePlayer(),
    onState: () => undefined,
  }
  return { c: new SpeechController(deps), direct, fallbacks, room }
}

describe('B5 hardening — worker leaves while a room utterance is in flight', () => {
  it('nothing heard yet → same exact text once via HTTP TTS immediately (no stuck Speaking state)', async () => {
    const { c, direct, fallbacks, room } = setup()
    await c.request('Wait for me', { partnerSpeaking: false })
    expect(c.state.kind).toBe('speaking')
    expect(await c.onWorkerLeft()).toBe('spoken')
    expect(fallbacks).toEqual(['worker_left'])
    expect(room.stop).toHaveBeenCalledTimes(1)
    expect(direct).toEqual([{ text: 'Wait for me', roomName: null }])
    expect(c.state.kind).toBe('idle')
    expect(await c.request('Next one', { partnerSpeaking: false })).not.toBe('busy')
  })

  it('audio may have been heard → Delivery uncertain, never an automatic replay', async () => {
    const { c, direct } = setup()
    await c.request('Half said', { partnerSpeaking: false })
    c.onWorkerStatus({ type: 'speaking', playbackAttemptId: c.activeAttempt! })
    expect(await c.onWorkerLeft()).toBe('uncertain')
    expect(direct).toEqual([])
    expect(c.state.kind).toBe('delivery_uncertain')
  })

  it('no in-flight utterance (finished / cancelled) → nothing happens', async () => {
    const { c, direct } = setup()
    expect(await c.onWorkerLeft()).toBe('none')
    await c.request('Done already', { partnerSpeaking: false })
    c.onWorkerStatus({ type: 'speaking', playbackAttemptId: c.activeAttempt! })
    c.onWorkerStatus({ type: 'done', playbackAttemptId: c.activeAttempt! })
    expect(await c.onWorkerLeft()).toBe('none')
    await c.request('Cancelled', { partnerSpeaking: false })
    c.onWorkerStatus({ type: 'cancelled', playbackAttemptId: c.activeAttempt! })
    expect(await c.onWorkerLeft()).toBe('none') // stale pending state is cleared on cancel
    expect(direct).toEqual([])
  })
})

describe('B5/B6 hardening — honest fallback notices', () => {
  it('remote calls: fallback audio is NOT audible to the far-end partner and the notice says so', () => {
    expect(fallbackAudibleToPartner('remote')).toBe(false)
    expect(fallbackNotice('remote', 'worker_no_ack')).toMatch(/remote partner cannot hear/)
  })
  it('co-located modes: the fallback is audible', () => {
    expect(fallbackAudibleToPartner('tabletop')).toBe(true)
    expect(fallbackAudibleToPartner('partner-link')).toBe(true)
    expect(fallbackNotice('tabletop', 'worker_left')).toMatch(/disconnected before speaking.*from this device/)
  })
  it('a secret mismatch names the fix', () => {
    expect(fallbackNotice('partner-link', 'worker_bad_signature')).toContain('REVOICE_APPROVAL_SECRET')
  })
})
