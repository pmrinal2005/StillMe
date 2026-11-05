import 'server-only'
import { adminClient } from './durable'
import { env } from './env'
import { count, hit } from './rate-limit'
import { hmacSha256Hex } from '../hash'

/**
 * B15 — phone bind brute-force guard.
 *
 * Bug: /api/phone/bind only counted an attempt when the submitted code MATCHED a live code (lookupPairCode increments
 * `attempts` after finding it). A guess that matched nothing cost the attacker nothing: anyone holding the public
 * inbound number could dial in and try the 10^6 six-digit codes (the worker only rate-limits within ONE call, and a
 * new call is free), then bind their own voice into the owner's private conversation.
 *
 * Now EVERY failed bind is counted in three independent scopes, durably across instances (Supabase `guard_hit`,
 * migration 0004; per-instance memory is the fallback and is still applied as a floor):
 *   - per call room     (one dial-in)            5 failures / 10 min
 *   - per caller identity (SIP caller)           10 failures / 60 min
 *   - global (all callers, all rooms)            30 failures / 10 min
 * Crossing ANY limit locks that scope AND burns every live pair code (owners must issue a fresh one), so a distributed
 * attacker cannot keep a code alive while guessing. A locked scope refuses before the code is even looked at.
 */
export const BIND_LIMITS = {
  call: { limit: 5, windowMs: 10 * 60_000 },
  identity: { limit: 10, windowMs: 60 * 60_000 },
  global: { limit: 30, windowMs: 10 * 60_000 },
} as const
export type BindScope = keyof typeof BIND_LIMITS

const isMissingRpc = (e: { code?: string; message?: string }) => e.code === 'PGRST202' || e.code === '42883' || /could not find the function|guard_hit|guard_count/i.test(e.message ?? '')

async function key(scope: BindScope, value: string): Promise<string> {
  return `bind:${scope}:${(await hmacSha256Hex(env.approvalSecret(), `guard:${scope}:${value}`)).slice(0, 40)}`
}

async function durableHit(k: string, windowMs: number): Promise<number | null> {
  const sb = adminClient()
  if (!sb) return null
  const { data, error } = await sb.rpc('guard_hit', { p_key: k, p_window_seconds: Math.ceil(windowMs / 1000) })
  if (error) return isMissingRpc(error) ? null : null
  return Number(data ?? 0)
}

async function durableCount(k: string, windowMs: number): Promise<number | null> {
  const sb = adminClient()
  if (!sb) return null
  const { data, error } = await sb.rpc('guard_count', { p_key: k, p_window_seconds: Math.ceil(windowMs / 1000) })
  if (error) return null
  return Number(data ?? 0)
}

const scopes = async (callRoom: string, identity: string): Promise<[BindScope, string][]> => [
  ['call', await key('call', callRoom)],
  ['identity', await key('identity', identity)],
  ['global', await key('global', 'all')],
]

/** Is this bind attempt allowed to proceed at all? (No side effects.) */
export async function bindAllowed(callRoom: string, identity: string, now = Date.now()): Promise<{ ok: true } | { ok: false; scope: BindScope }> {
  for (const [scope, k] of await scopes(callRoom, identity)) {
    const { limit, windowMs } = BIND_LIMITS[scope]
    const d = await durableCount(k, windowMs)
    const n = Math.max(d ?? 0, count(k, windowMs, now))
    if (n >= limit) return { ok: false, scope }
  }
  return { ok: true }
}

/** Record ONE failed bind in every scope. Returns the scopes that are now at/over their limit (→ caller burns codes). */
export async function recordBindFailure(callRoom: string, identity: string, now = Date.now()): Promise<BindScope[]> {
  const tripped: BindScope[] = []
  for (const [scope, k] of await scopes(callRoom, identity)) {
    const { limit, windowMs } = BIND_LIMITS[scope]
    const local = hit(k, windowMs, now)
    const d = await durableHit(k, windowMs)
    if (Math.max(local, d ?? 0) >= limit) tripped.push(scope)
  }
  return tripped
}
