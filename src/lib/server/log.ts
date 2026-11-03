import 'server-only'

/**
 * Content-free structured logging. Only allow-listed metadata keys are emitted — never
 * transcripts, drafts, approved text, or audio. Raw-content logging is disabled by default
 * and there is no switch to enable it.
 */
const ALLOWED = new Set([
  'evt', 'attempt', 'chars', 'billed', 'req', 'tokens', 'status', 'reason', 'ms', 'room', 'voice',
  'kind', 'code', 'provider', 'minutes', 'usd', 'retryAfter', 'generation', 'turn', 'revision', 'route', 'via', 'repeat',
])

export function logEvent(fields: Record<string, unknown>) {
  const out: Record<string, unknown> = { t: new Date().toISOString() }
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED.has(k)) continue
    if (typeof v === 'string') out[k] = v.slice(0, 64)
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v
  }
  console.log(JSON.stringify(out))
}
