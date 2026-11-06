#!/usr/bin/env node
/**
 * Opt-in, budget-capped LIVE smoke test (never runs in CI / `npm test`).
 *
 *   ASSEMBLYAI_API_KEY=... node scripts/live-smoke.mjs                 # AssemblyAI only
 *   ASSEMBLYAI_API_KEY=... REVOICE_BASE_URL=https://stillmee.vercel.app node scripts/live-smoke.mjs
 *
 * The key is read from the environment ONLY — never hard-code it, never commit it.
 * Estimated spend: ~150 TTS characters (~$0.002) + ~10 s of streaming STT (~$0.001).
 * Phase-0 policy allows a $2 smoke envelope; this uses a tiny fraction of it.
 *
 * Checks (AssemblyAI direct):
 *   1. every LIBRARY voice in src/lib/voices.ts synthesizes in its listed language
 *   2. hindi is rejected as an output language (not supported by assemblyai-tts-1)
 *   3. STT round-trip with universal-3-6-pro: TTS audio -> streaming STT -> same words
 * Checks (deployed app, when REVOICE_BASE_URL is set):
 *   4. approve -> speak streams PCM; replay is rejected (409); altered text is rejected (409)
 *   5. an unapproved cloned voice is refused (403); malformed bodies get JSON errors
 *   6. no sign-in anywhere: an anonymous device cookie is issued, device keys round-trip, forged keys are refused
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const KEY = process.env.ASSEMBLYAI_API_KEY
const BASE = (process.env.REVOICE_BASE_URL || '').replace(/\/$/, '')
const REGION = process.env.ASSEMBLYAI_REGION === 'eu' ? 'eu' : 'us'
if (!KEY) {
  console.error('ASSEMBLYAI_API_KEY is required (environment variable).')
  process.exit(2)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const voicesSrc = readFileSync(path.join(root, 'src/lib/voices.ts'), 'utf8')
const voices = [...voicesSrc.matchAll(/id: '(aai-[a-z]+)', name: '[^']+', language: '([a-z]+)'/g)].map((m) => ({ id: m[1], language: m[2] }))

let pass = 0
let fail = 0
const ok = (name, detail = '') => (pass++, console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`))
const bad = (name, detail = '') => (fail++, console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`))

const ttsUrl = `https://tts.${REGION}.assemblyai.com/v1/speech`
async function tts(text, voice, language, sampleRate = 24000) {
  return fetch(ttsUrl, {
    method: 'POST',
    headers: { authorization: KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voice, language, model_id: 'assemblyai-tts-1', encoding: 'pcm_s16le', sample_rate: sampleRate }),
  })
}

console.log('1) library voices (AssemblyAI TTS)')
let billed = 0
for (const v of voices) {
  const r = await tts('Hi.', v.id, v.language)
  if (r.ok) {
    const b = new Uint8Array(await r.arrayBuffer())
    billed += Number(r.headers.get('x-tts-billed-characters') || 0)
    b.length > 1000 ? ok(`${v.id} (${v.language})`, `${b.length} bytes`) : bad(`${v.id} (${v.language})`, 'suspiciously short audio')
  } else bad(`${v.id} (${v.language})`, `HTTP ${r.status} ${(await r.text()).slice(0, 120)}`)
}
console.log(`     billed characters so far: ${billed}`)

console.log('2) unsupported output language')
{
  const r = await tts('Namaste.', 'aai-audrey', 'hindi')
  r.status === 422 ? ok('hindi rejected by TTS', 'HTTP 422') : bad('hindi should be rejected', `HTTP ${r.status}`)
}

console.log('3) STT round trip (universal-3-6-pro)')
{
  const sentence = 'Are you free for dinner on Friday? I was thinking about seven o clock.'
  const r = await tts(sentence, 'aai-sara', 'english', 16000)
  if (!r.ok) bad('synthesize test audio', `HTTP ${r.status}`)
  else {
    const pcm = new Uint8Array(await r.arrayBuffer())
    const base = REGION === 'eu' ? 'streaming.eu.assemblyai.com' : 'streaming.assemblyai.com'
    const tokRes = await fetch(`https://${base}/v3/token?expires_in_seconds=60&max_session_duration_seconds=90`, { headers: { authorization: KEY } })
    if (!tokRes.ok) bad('temporary STT token', `HTTP ${tokRes.status}`)
    else {
      ok('temporary STT token')
      const { token } = await tokRes.json()
      const q = new URLSearchParams({ token, speech_model: 'universal-3-6-pro', sample_rate: '16000', encoding: 'pcm_s16le', format_turns: 'true', mode: 'balanced' })
      const finals = []
      let modelSeen = ''
      await new Promise((resolve) => {
        const ws = new WebSocket(`wss://${base}/v3/ws?${q}`)
        ws.binaryType = 'arraybuffer'
        const timer = setTimeout(() => { try { ws.close() } catch {} resolve() }, 45_000)
        ws.onmessage = (ev) => {
          const m = JSON.parse(String(ev.data))
          if (m.type === 'Begin') {
            modelSeen = m.configuration?.model ?? ''
            ;(async () => {
              const step = 3200
              for (let i = 0; i < pcm.length; i += step) { ws.send(pcm.slice(i, i + step)); await new Promise((r) => setTimeout(r, 100)) }
              ws.send(new Uint8Array(step * 10))
              await new Promise((r) => setTimeout(r, 2500))
              ws.send(JSON.stringify({ type: 'Terminate' }))
            })()
          } else if (m.type === 'Turn' && m.end_of_turn) finals.push(m.transcript)
          else if (m.type === 'Termination') { clearTimeout(timer); resolve() }
        }
        ws.onerror = () => { clearTimeout(timer); resolve() }
        ws.onclose = () => { clearTimeout(timer); resolve() }
      })
      const heard = finals.join(' ').toLowerCase()
      modelSeen === 'universal-3-6-pro' ? ok('model is universal-3-6-pro') : bad('model', modelSeen || 'no Begin message');
      /dinner on friday/.test(heard) ? ok('transcript matches', `"${finals.join(' ')}"`) : bad('transcript mismatch', `"${finals.join(' ')}"`)
    }
  }
}

if (BASE) {
  console.log(`4) deployed app: ${BASE}`)
  let cookie = ''
  const call = async (p, body, extra = {}) => {
    const res = await fetch(BASE + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), ...extra })
    const sc = res.headers.get('set-cookie')
    if (sc) cookie = sc.split(';')[0]
    return res
  }
  const sha = (t) => createHash('sha256').update(t.normalize('NFC')).digest('hex')
  const stRes = await call('/api/status')
  const st = await stRes.json()
  // NO SIGN-IN: the first call mints an anonymous, signed, HttpOnly device cookie. There is nothing to log in to.
  stRes.ok && st.providers ? ok('status served with no sign-in') : bad('status', `HTTP ${stRes.status} ${JSON.stringify(st).slice(0, 120)}`)
  cookie.startsWith('rv_device=') ? ok('anonymous device cookie issued') : bad('device cookie missing', cookie.slice(0, 40))
  st.identity === undefined && st.operator === undefined ? ok('status exposes no identity or operator data') : bad('status leaks identity/operator data')
  st.providers?.assemblyai ? ok('server has AssemblyAI configured') : bad('server missing ASSEMBLYAI_API_KEY')
  st.providers?.approvalSecretConfigured ? ok('stable approval secret', st.providers.approvalSecretSource) : bad('approval secret unstable')

  const text = 'Hello, this is a live smoke test.'
  const ap = await (await call('/api/approve', { text, textHash: sha(text), conversationId: 'smoke-' + Date.now(), generation: 0, voiceId: 'aai-audrey', outputLanguage: 'english' })).json()
  if (!ap.approval) bad('approve', JSON.stringify(ap).slice(0, 120))
  else {
    let sp = await call('/api/speak', { approval: ap.approval, text })
    if (sp.status === 429) {
      // Provider rate limit right after the voice sweep above: wait, then retry with a FRESH approval.
      const wait = Math.min(15, Number(sp.headers.get('retry-after')) || 8)
      console.log(`     429 from /api/speak (${(await sp.text()).slice(0, 80)}); retrying in ${wait}s`)
      await new Promise((r) => setTimeout(r, wait * 1000))
      const ap2 = await (await call('/api/approve', { text, textHash: sha(text), conversationId: 'smoke-r-' + Date.now(), generation: 0, voiceId: 'aai-audrey', outputLanguage: 'english' })).json()
      ap.approval = ap2.approval
      sp = await call('/api/speak', { approval: ap.approval, text })
    }
    const len = sp.ok ? (await sp.arrayBuffer()).byteLength : 0
    sp.ok && len > 10_000 ? ok('speak streams PCM', `${len} bytes`) : bad('speak', `HTTP ${sp.status} ${sp.ok ? '' : await sp.text().catch(() => '')}`)
    const replay = await call('/api/speak', { approval: ap.approval, text })
    replay.status === 409 ? ok('replayed approval rejected') : bad('replay should be 409', `HTTP ${replay.status}`)
    const alt = await call('/api/speak', { approval: ap.approval, text: 'Tampered words' })
    alt.status === 409 ? ok('altered text rejected') : bad('altered text should be 409', `HTTP ${alt.status}`)
  }
  const clone = await call('/api/approve', { text: 'Test', textHash: sha('Test'), conversationId: 'smoke-c', generation: 0, voiceId: 'unregistered-clone', outputLanguage: 'english' })
  // A cloned voice id alone never grants use: it must be registered to THIS device identity.
  clone.status === 403 ? ok('unregistered cloned voice refused', `HTTP ${clone.status}`) : bad('clone should be refused', `HTTP ${clone.status}`)
  const sess = await call('/api/livekit/session', {})
  sess.status !== 401 ? ok('listening session route does not demand sign-in', `HTTP ${sess.status}`) : bad('listening session still demands sign-in')
  const key = await (await call('/api/device')).json().catch(() => ({}))
  ;/^[0-9a-f]{32}\.[0-9a-f]{64}$/.test(key.key ?? '') ? ok('device key available for backup') : bad('device key', JSON.stringify(key).slice(0, 80))
  const forged = await call('/api/device', { key: '0'.repeat(32) + '.' + '0'.repeat(64) })
  forged.status === 400 ? ok('forged device key refused') : bad('forged device key should be 400', `HTTP ${forged.status}`)
  const junk = await call('/api/speak', 'not json')
  const jb = await junk.json().catch(() => null)
  junk.status === 400 && jb?.error ? ok('malformed body -> JSON error') : bad('malformed body', `HTTP ${junk.status}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
