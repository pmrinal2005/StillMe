import 'server-only'
import { AccessToken, AgentDispatchClient, RoomServiceClient, TrackSource } from 'livekit-server-sdk'
import { env } from './env'
import { hmacSha256Hex, randomId, timingSafeEqualHex } from '../hash'

/**
 * Short-lived, least-privilege LiveKit participant tokens.
 *
 *  owner   — may publish data (approve/stop) but NOT audio by default in partner-link mode;
 *            in tabletop mode it publishes the microphone that the worker transcribes.
 *  partner — joins via an expiring signed invite; may publish microphone only; cannot publish data
 *            that the worker would treat as control (worker only accepts control from the owner identity).
 *
 * Room names are random and unguessable, but authorization — not obscurity — is the boundary.
 */

export const TOKEN_TTL_SECONDS = 15 * 60
export const INVITE_TTL_MS = 30 * 60 * 1000

function hostUrl() {
  const u = env.livekitUrl()
  if (!u) throw new Error('LIVEKIT_URL not configured')
  return u.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
}

export function newRoomName(): string {
  return `rv-${randomId(12)}`
}

export interface RoomMetadata {
  ownerIdentity: string
  conversationId: string
  generation: number
  mode: 'tabletop' | 'partner-link' | 'remote'
  voiceId: string
  outputLanguage: string
  inputLanguages: string[]
  keyterms: string[]
  contextPrompt?: string
  maxSessionMinutes: number
  /** B3/B4: server-set bookkeeping so ANY serverless instance can settle/close this room. Ignored by the worker. */
  startedAt?: number
  sttMinutes?: number
  sttReservationId?: string | null
  /**
   * Open item (phone, cross-instance): the owner's live pair code, stored HMAC-hashed (never in clear)
   * so /api/phone/bind on ANY instance can find it. Room metadata is visible to room participants, but
   * the hash is keyed with the server secret, so the 6-digit code cannot be brute-forced from it.
   */
  phonePair?: { codeHash: string; expiresAt: number; attempts: number } | null
  /** Minutes reserved for an in-progress inbound call (settled by /api/phone/usage on any instance). */
  phoneCall?: { identity: string; minutes: number; month: string; at: number } | null
}

export async function ownerToken(opts: { identity: string; room: string; mode: RoomMetadata['mode'] }) {
  const key = env.livekitKey()
  const secret = env.livekitSecret()
  if (!key || !secret) throw new Error('LiveKit not configured')
  const at = new AccessToken(key, secret, { identity: opts.identity, ttl: TOKEN_TTL_SECONDS, attributes: { role: 'owner' } })
  at.addGrant({
    room: opts.room,
    roomJoin: true,
    canSubscribe: true,
    canPublishData: true,
    // In partner-link/remote mode the owner's device primarily sends control events.
    canPublish: opts.mode === 'tabletop',
    // B1: livekit-server-sdk >= 2.x requires the TrackSource ENUM here; passing the string
    // 'microphone' made toJwt() throw ("Cannot convert TrackSource microphone to string").
    canPublishSources: opts.mode === 'tabletop' ? [TrackSource.MICROPHONE] : [],
    canUpdateOwnMetadata: false,
  })
  return at.toJwt()
}

export async function partnerToken(opts: { room: string; label: string }) {
  const key = env.livekitKey()
  const secret = env.livekitSecret()
  if (!key || !secret) throw new Error('LiveKit not configured')
  const identity = `partner-${randomId(6)}`
  const at = new AccessToken(key, secret, { identity, name: opts.label.slice(0, 40), ttl: TOKEN_TTL_SECONDS, attributes: { role: 'partner' } })
  at.addGrant({
    room: opts.room,
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE], // B1: enum, not string
    canPublishData: false,
    canUpdateOwnMetadata: false,
  })
  return { token: await at.toJwt(), identity }
}

/** Create the room with metadata the worker trusts (set server-side only) and dispatch the worker explicitly. */
export async function createRoomAndDispatch(room: string, meta: RoomMetadata) {
  const host = hostUrl()
  const rs = new RoomServiceClient(host, env.livekitKey()!, env.livekitSecret()!)
  await rs.createRoom({
    name: room,
    emptyTimeout: 120,
    departureTimeout: 30,
    maxParticipants: 4,
    metadata: JSON.stringify(meta),
  })
  const dispatch = new AgentDispatchClient(host, env.livekitKey()!, env.livekitSecret()!)
  await dispatch.createDispatch(room, env.livekitAgentName(), { metadata: JSON.stringify({ conversationId: meta.conversationId }) })
}

export async function deleteRoom(room: string) {
  const rs = new RoomServiceClient(hostUrl(), env.livekitKey()!, env.livekitSecret()!)
  await rs.deleteRoom(room).catch(() => undefined)
}

export function parseMeta(raw: string | undefined): RoomMetadata | null {
  if (!raw) return null
  try {
    const m = JSON.parse(raw) as RoomMetadata
    return m && typeof m.ownerIdentity === 'string' && typeof m.conversationId === 'string' ? m : null
  } catch {
    return null
  }
}

/**
 * B4: LiveKit is the cross-instance source of truth for which rooms exist and who owns them
 * (metadata is set server-side only at creation). Returns null if the room does not exist.
 */
export async function getRoomMeta(room: string): Promise<RoomMetadata | null> {
  const rs = new RoomServiceClient(hostUrl(), env.livekitKey()!, env.livekitSecret()!)
  const rooms = await rs.listRooms([room])
  const r = rooms.find((x) => x.name === room)
  return r ? parseMeta(r.metadata) : null
}

/** B4: all live owner rooms of a user (used to enforce one active conversation per user across instances). */
export async function listOwnerRooms(userId: string): Promise<{ room: string; meta: RoomMetadata }[]> {
  const rs = new RoomServiceClient(hostUrl(), env.livekitKey()!, env.livekitSecret()!)
  const rooms = await rs.listRooms()
  const out: { room: string; meta: RoomMetadata }[] = []
  for (const r of rooms) {
    if (!r.name.startsWith('rv-')) continue
    const m = parseMeta(r.metadata)
    if (m && m.ownerIdentity === userId) out.push({ room: r.name, meta: m })
  }
  return out
}

/** Expiring, signed partner invite: rv1.<room>.<exp>.<sig> — never relies on room-name secrecy alone. */
export async function signInvite(room: string, ownerIdentity: string, now = Date.now()) {
  const exp = now + INVITE_TTL_MS
  const sig = await hmacSha256Hex(env.approvalSecret(), `invite:${room}:${ownerIdentity}:${exp}`)
  return `rv1.${room}.${ownerIdentity}.${exp}.${sig}`
}

export async function verifyInvite(invite: string, now = Date.now()): Promise<{ room: string; ownerIdentity: string } | null> {
  const parts = invite.split('.')
  if (parts.length !== 5 || parts[0] !== 'rv1') return null
  const [, room, ownerIdentity, expS, sig] = parts
  const exp = Number(expS)
  if (!Number.isFinite(exp) || now > exp) return null
  const expected = await hmacSha256Hex(env.approvalSecret(), `invite:${room}:${ownerIdentity}:${exp}`)
  if (!timingSafeEqualHex(expected, sig)) return null
  return { room, ownerIdentity }
}

/** Replace a room's server-set metadata (read-modify-write callers only; see phone-store.ts). */
export async function updateRoomMeta(room: string, meta: RoomMetadata): Promise<void> {
  const rs = new RoomServiceClient(hostUrl(), env.livekitKey()!, env.livekitSecret()!)
  await rs.updateRoomMetadata(room, JSON.stringify(meta))
}

/** All live ReVOICE owner rooms with valid metadata (any owner). */
export async function listAllOwnerRooms(): Promise<{ room: string; meta: RoomMetadata }[]> {
  const rs = new RoomServiceClient(hostUrl(), env.livekitKey()!, env.livekitSecret()!)
  const out: { room: string; meta: RoomMetadata }[] = []
  for (const r of await rs.listRooms()) {
    if (!r.name.startsWith('rv-')) continue
    const m = parseMeta(r.metadata)
    if (m) out.push({ room: r.name, meta: m })
  }
  return out
}
