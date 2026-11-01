#!/usr/bin/env node
/**
 * Post-build secret scanner. Fails the build if any server-only secret VALUE, or a
 * well-known provider-key PATTERN, appears in browser-delivered assets.
 *
 * Scans: .next/static/** (all client JS/CSS) and prerendered HTML/RSC payloads.
 * Server bundles (.next/server/**) are excluded except prerendered *.html / *.rsc / *.body,
 * which ARE sent to browsers.
 */
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const nextDir = path.join(root, '.next')
if (!fs.existsSync(nextDir)) {
  console.log('[scan-secrets] no .next directory — nothing to scan')
  process.exit(0)
}

const SECRET_ENV = [
  'ASSEMBLYAI_API_KEY',
  'GROQ_API_KEY',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'REVOICE_APPROVAL_SECRET',
]

// Load .env-style files so values configured only in files are also checked.
function loadEnvFile(f) {
  const p = path.join(root, f)
  if (!fs.existsSync(p)) return {}
  const out = {}
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}
const fileEnv = { ...loadEnvFile('.env'), ...loadEnvFile('.env.local'), ...loadEnvFile('.env.production') }

const values = []
for (const name of SECRET_ENV) {
  const v = process.env[name] || fileEnv[name]
  if (v && v.length >= 8) values.push({ name, v })
}

const PATTERNS = [
  { name: 'groq-key', re: /gsk_[A-Za-z0-9]{20,}/ },
  { name: 'livekit-secret-assignment', re: /LIVEKIT_API_SECRET\s*[:=]\s*["'][^"']{8,}/ },
  { name: 'supabase-service-role-jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*c2VydmljZV9yb2xl[A-Za-z0-9_-]*\./ },
  { name: 'server-env-name-inlined', re: /process\.env\.(ASSEMBLYAI_API_KEY|GROQ_API_KEY|LIVEKIT_API_SECRET|SUPABASE_SERVICE_ROLE_KEY|REVOICE_APPROVAL_SECRET)/ },
  { name: 'private-key-block', re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
]

function* walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}

const targets = []
for (const f of walk(path.join(nextDir, 'static'))) targets.push(f)
for (const f of walk(path.join(nextDir, 'server', 'app'))) if (/\.(html|rsc|body)$/.test(f)) targets.push(f)
for (const f of walk(path.join(root, 'public'))) targets.push(f)

let findings = 0
for (const f of targets) {
  let txt
  try {
    txt = fs.readFileSync(f, 'utf8')
  } catch {
    continue
  }
  for (const { name, v } of values) {
    if (txt.includes(v)) {
      console.error(`[scan-secrets] LEAK: value of ${name} found in ${path.relative(root, f)}`)
      findings++
    }
  }
  for (const { name, re } of PATTERNS) {
    if (re.test(txt)) {
      console.error(`[scan-secrets] LEAK: pattern ${name} found in ${path.relative(root, f)}`)
      findings++
    }
  }
}

if (findings) {
  console.error(`[scan-secrets] ${findings} potential secret leak(s) in browser assets. Failing build.`)
  process.exit(1)
}
console.log(`[scan-secrets] OK — scanned ${targets.length} browser-delivered files, ${values.length} configured secret value(s), ${PATTERNS.length} patterns. No leaks.`)
