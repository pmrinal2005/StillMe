import 'server-only'
import type { RoomMetadata } from './livekit'
import { MAX_BIND_ATTEMPTS_PER_CODE } from '../phone'

/**
 * Open item — phone pairing across serverless instances.
 *
 * Bug: pair codes, bind attempts and in-progress call reservations lived only in one instance's
 * memory (`rv().phoneCodes`, `rv().phoneReservations`). On Vercel the owner's `/api/phone/pair` and
 * the worker's `/api/phone/bind` / `/api/phone/usage` routinely hit DIFFERENT instances, so a valid
 * code was "invalid_code" and finished calls were never settled.
 *
 * Fix: the owner room's server-set LiveKit metadata is the cross-instance store (the same source of
 * truth B4 uses for ownership). It holds the HASHED pair code (+ expiry, attempt counter) and the
 * current call reservation. All logic is pure over a small `RoomMetaStore` interface so it is
 * unit-tested without LiveKit; the LiveKit implementation lives in `livekitRoomStore()`.
 *
 * Concurrency: LiveKit metadata updates are last-writer-wins. Pair/bind for one owner are serialized
 * by the human flow (one code, one caller, DTMF), and the attempt cap is additionally enforced per
 * instance, so the remaining race can at worst grant one extra guess — never bypass the HMAC.
 */
export interface RoomMetaStore {
  get(room: string): Promise<RoomMetadata | null>
  list(): Promise<{ room: string; meta: RoomMetadata }[]>
  update(room: string, meta: RoomMetadata): Promise<void>
}

export async function livekitRoomStore(): Promise<RoomMetaStore> {
  const lk = await import('./livekit')
  return { get: lk.getRoomMeta, list: lk.listAllOwnerRooms, update: lk.updateRoomMeta }
}

/** Store a fresh pair code for the owner's room (replaces any previous code: one live code per owner). */
export async function storePairCode(store: RoomMetaStore, userId: string, room: string, codeHash: string, expiresAt: number): Promise<boolean> {
  const meta = await store.get(room)
  if (!meta || meta.ownerIdentity !== userId) return false
  await store.update(room, { ...meta, phonePair: { codeHash, expiresAt, attempts: 0 } })
  return true
}

/** Remove every outstanding pair code of this owner (revoke, e.g. code read to the wrong person). */
export async function revokePairCodes(store: RoomMetaStore, userId: string): Promise<number> {
  let n = 0
  for (const { room, meta } of await store.list()) {
    if (meta.ownerIdentity !== userId || !meta.phonePair) continue
    await store.update(room, { ...meta, phonePair: null })
    n++
  }
  return n
}

export type PairLookup =
  | { ok: true; room: string; meta: RoomMetadata }
  | { ok: false; reason: 'invalid_code' }

/**
 * Look up a code hash across live owner rooms and count the attempt. Expired codes and codes past the
 * attempt cap are deleted and rejected. The caller must `consumePairCode` once the call is bound.
 */
export async function lookupPairCode(store: RoomMetaStore, codeHash: string, now = Date.now()): Promise<PairLookup> {
  for (const { room, meta } of await store.list()) {
    const p = meta.phonePair
    if (!p || p.codeHash !== codeHash) continue
    if (p.expiresAt < now) {
      await store.update(room, { ...meta, phonePair: null })
      return { ok: false, reason: 'invalid_code' }
    }
    const attempts = p.attempts + 1
    if (attempts > MAX_BIND_ATTEMPTS_PER_CODE) {
      await store.update(room, { ...meta, phonePair: null })
      return { ok: false, reason: 'invalid_code' }
    }
    const next = { ...meta, phonePair: { ...p, attempts } }
    await store.update(room, next)
    return { ok: true, room, meta: next }
  }
  return { ok: false, reason: 'invalid_code' }
}

/** Single use: drop the code and record the granted call reservation in the same metadata write. */
export async function consumePairCode(store: RoomMetaStore, room: string, call: { identity: string; minutes: number; month: string; at: number } | null): Promise<void> {
  const meta = await store.get(room)
  if (!meta) return
  await store.update(room, { ...meta, phonePair: null, phoneCall: call ?? meta.phoneCall ?? null })
}

/** Drop a pair code without granting a call (no session, cap reached, …). */
export async function dropPairCode(store: RoomMetaStore, room: string): Promise<void> {
  const meta = await store.get(room)
  if (meta?.phonePair) await store.update(room, { ...meta, phonePair: null })
}

/** Take (and clear) the call reservation of a room, for settlement by /api/phone/usage. */
export async function takePhoneCall(store: RoomMetaStore, room: string): Promise<{ meta: RoomMetadata; call: NonNullable<RoomMetadata['phoneCall']> } | null> {
  const meta = await store.get(room)
  if (!meta?.phoneCall) return null
  await store.update(room, { ...meta, phoneCall: null })
  return { meta, call: meta.phoneCall }
}

/**
 * B15: burn EVERY live pair code (all owners). Called when the bind guard trips, so a brute-forcer cannot keep a
 * code alive while guessing. Owners simply issue a fresh code. Returns how many rooms were cleared.
 */
export async function burnAllPairCodes(store: RoomMetaStore): Promise<number> {
  let n = 0
  for (const { room, meta } of await store.list()) {
    if (!meta.phonePair) continue
    await store.update(room, { ...meta, phonePair: null })
    n++
  }
  return n
}
