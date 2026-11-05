/**
 * B16 — sealed room metadata.
 *
 * LiveKit room metadata is readable by EVERY participant (the partner's browser exposes `room.metadata`).
 * It used to hold the owner's user id, key terms and the context prompt (names / medical vocabulary), and
 * the cross-instance bookkeeping (ticket ids, phone pair state). Now:
 *   - worker configuration (voice, language, key terms, context prompt, opaque owner identity) travels in the
 *     AGENT DISPATCH metadata, which is delivered to the worker job only — never to participants;
 *   - the server's own cross-instance bookkeeping stays in room metadata but is AES-256-GCM sealed with a key
 *     derived from the shared approval secret and bound to the room name (AAD). Participants see an opaque blob.
 *
 * Format: rvm1.<base64url(iv)>.<base64url(ciphertext+tag)>
 */
import { hmacSha256Hex } from './hash'

export const SEAL_PREFIX = 'rvm1'
const KEY_LABEL = 'revoice/room-meta/v1'
const enc = new TextEncoder()
const dec = new TextDecoder()

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function b64u(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function sealKey(secret: string): Promise<CryptoKey> {
  const raw = hexToBytes(await hmacSha256Hex(secret, KEY_LABEL))
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

const aad = (room: string) => enc.encode(`room:${room}`)

export async function sealRoomMeta(secret: string, room: string, meta: unknown): Promise<string> {
  const iv = new Uint8Array(new ArrayBuffer(12))
  crypto.getRandomValues(iv)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(room) }, await sealKey(secret), enc.encode(JSON.stringify(meta)))
  return `${SEAL_PREFIX}.${b64u(iv)}.${b64u(new Uint8Array(ct))}`
}

/** Returns null for anything that is not a valid blob sealed for THIS room (plaintext, other room, tampered, wrong key). */
export async function openRoomMeta<T = unknown>(secret: string, room: string, raw: string | undefined | null): Promise<T | null> {
  if (!raw || raw.length > 60_000) return null
  const parts = raw.split('.')
  if (parts.length !== 3 || parts[0] !== SEAL_PREFIX) return null
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(parts[1]), additionalData: aad(room) }, await sealKey(secret), unb64u(parts[2]))
    return JSON.parse(dec.decode(pt)) as T
  } catch {
    return null
  }
}
