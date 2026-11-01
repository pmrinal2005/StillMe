import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ADDONS, TELEPHONY, assertSafeDefaults } from '@/lib/features'
import { STT_MODEL, TTS_MODEL } from '@/lib/contracts'

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

describe('feature flags & invariants', () => {
  it('safe defaults hold', () => {
    expect(() => assertSafeDefaults()).not.toThrow()
    expect(Object.values(ADDONS).every((v) => v === false)).toBe(true)
    expect(TELEPHONY.monthlyInboundMinutesCap).toBe(40)
    expect(TELEPHONY.outboundPstn || TELEPHONY.paidCarriers || TELEPHONY.emergencyCalling).toBe(false)
  })
  it('models are selected explicitly', () => {
    expect(STT_MODEL).toBe('universal-3-6-pro')
    expect(TTS_MODEL).toBe('assemblyai-tts-1')
  })
  it('no Hono / Cloudflare / LLM Gateway in the source', () => {
    const files = walk(path.resolve(__dirname, '../src')).filter((f) => /\.(ts|tsx)$/.test(f))
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/from ['"]hono|@cloudflare\/|wrangler/)
      expect(src, f).not.toMatch(/llm-gateway\.assemblyai|llm_gateway/i)
    }
  })
  it('server secrets are never exposed with a NEXT_PUBLIC_ prefix', () => {
    const files = walk(path.resolve(__dirname, '../src'))
    for (const f of files) expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/NEXT_PUBLIC_(ASSEMBLYAI|GROQ|LIVEKIT_API|SUPABASE_SERVICE|REVOICE_APPROVAL)/)
  })
  it('client modules never import server-only modules', () => {
    const client = walk(path.resolve(__dirname, '../src')).filter((f) => /\.(ts|tsx)$/.test(f) && /^['"]use client['"]/m.test(fs.readFileSync(f, 'utf8')))
    expect(client.length).toBeGreaterThan(0)
    for (const f of client) expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(/lib\/server\//)
  })
})
