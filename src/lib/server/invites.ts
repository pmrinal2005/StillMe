import 'server-only'
import { adminClient } from './durable'
import { getRoomMeta, updateRoomMeta } from './livekit'

/**
 * B17 — single-use partner invites.
 *
 * Bug: an invite was a reusable bearer link (and, in the first version, carried the owner's user id). Anyone who saw
 * it — a forwarded message, a shoulder-surfed screen, a browser history entry — could join the conversation as a
 * transcribed partner for the whole 30 minutes, any number of times.
 *
 * Now every invite has a random id (`jti`) that is consumed ATOMICALLY exactly once:
 *   1. Supabase RPC `consume_invite` (migration 0004): unique-insert, correct on every serverless instance;
 *   2. only if that RPC does not exist yet (migration not applied) → the id is recorded in the SEALED room metadata
 *      (+ this instance's memory). That fallback is last-writer-wins, so two truly simultaneous joins could both pass;
 *      it is documented and disappears once 0004 is applied.
 * Any other durable-store error FAILS CLOSED (nobody joins).
 */
export type InviteConsume = 'ok' | 'used' | 'unavailable'

const g = globalThis as unknown as { __rvInvites?: Map<string, number> }
const usedHere = () => (g.__rvInvites ??= new Map())

const isMissingRpc = (e: { code?: string; message?: string }) => e.code === 'PGRST202' || e.code === '42883' || /could not find the function|consume_invite/i.test(e.message ?? '')

export async function consumeInvite(jti: string, room: string, exp: number, now = Date.now()): Promise<InviteConsume> {
  const sb = adminClient()
  if (sb) {
    const { data, error } = await sb.rpc('consume_invite', { p_jti: jti, p_room: room, p_expires_at: new Date(exp).toISOString() })
    if (!error) return data === true ? 'ok' : 'used'
    if (!isMissingRpc(error)) return 'unavailable' // fail closed
  }
  // Fallback store (no migration 0004, or no durable store at all).
  const m = usedHere()
  for (const [k, e] of m) if (e < now) m.delete(k)
  if (m.has(jti)) return 'used'
  const meta = await getRoomMeta(room).catch(() => undefined)
  if (!meta) return 'unavailable'
  if (meta.usedInvites?.includes(jti)) return 'used'
  m.set(jti, exp + 60_000)
  try {
    await updateRoomMeta(room, { ...meta, usedInvites: [...(meta.usedInvites ?? []), jti].slice(-50) })
  } catch {
    m.delete(jti)
    return 'unavailable'
  }
  return 'ok'
}

/** Test helper. */
export function resetInviteMemory() {
  g.__rvInvites = undefined
}
