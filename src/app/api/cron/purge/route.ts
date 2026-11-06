import { json } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { purgeAll } from '@/lib/server/ops-db'
import { logEvent } from '@/lib/server/log'
import { withJsonErrors } from '@/lib/server/route'
import { timingSafeEqualHex, sha256Hex } from '@/lib/hash'

export const dynamic = 'force-dynamic'

/**
 * E49: scheduled retention purge (Vercel Cron, see vercel.json). Vercel sends `Authorization: Bearer $CRON_SECRET`.
 * FAIL CLOSED: without CRON_SECRET (or the approval secret as a stand-in) nobody can trigger it. Content-free: only
 * per-table row counts are logged. The purge is idempotent, so running it from pg_cron as well is harmless.
 */
async function authorized(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return false
  const given = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!given) return false
  return timingSafeEqualHex(await sha256Hex(given), await sha256Hex(secret))
}

async function handleGET(req: Request) {
  if (!(await authorized(req))) return json({ error: 'unauthorized' }, 401)
  if (!env.supabaseUrl() || !env.supabaseService()) return json({ ok: true, skipped: 'no_durable_store' })
  const r = await purgeAll()
  logEvent({ evt: 'purge', status: r.ok ? 'ok' : 'error', reason: r.ok ? undefined : r.reason })
  return r.ok ? json({ ok: true, counts: r.counts }) : json({ error: r.reason }, 502)
}

export const GET = withJsonErrors('cron/purge', handleGET)
export const POST = GET
