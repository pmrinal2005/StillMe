import 'server-only'
import { hmacSha256Hex, timingSafeEqualHex } from '../hash'

/**
 * Worker → web-app authentication. Header `x-revoice-worker: <ts>.<hmac(secret, "worker:<ts>:<body>")>`.
 * Must match worker_auth_header() in worker/revoice_worker/phone.py. Short skew window + single-use
 * signatures prevent replays of captured requests.
 */
export const WORKER_SKEW_MS = 60_000
const seen = new Map<string, number>()

export async function verifyWorkerAuth(secret: string, header: string | null, body: string, now = Date.now()): Promise<boolean> {
  if (!header) return false
  const [tsS, sig] = header.split('.')
  const ts = Number(tsS)
  if (!Number.isFinite(ts) || !sig || Math.abs(now - ts) > WORKER_SKEW_MS) return false
  const expected = await hmacSha256Hex(secret, `worker:${ts}:${body}`)
  if (!timingSafeEqualHex(expected, sig)) return false
  for (const [k, t] of seen) if (now - t > 2 * WORKER_SKEW_MS) seen.delete(k)
  if (seen.has(sig)) return false
  seen.set(sig, now)
  return true
}
