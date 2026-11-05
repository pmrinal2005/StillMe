import 'server-only'
import { AccessToken, AgentDispatchClient, RoomServiceClient, TrackSource } from 'livekit-server-sdk'
import { env } from './env'
import { hmacSha256Hex, randomId, timingSafeEqualHex } from '../hash'
import { openRoomMeta, sealRoomMeta } from '../room-seal'
import { ROOM_RE } from '../spend-refs'

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

/**
 * B16: SERVER-ONLY bookkeeping. This object is AES-GCM sealed (room-seal.ts) before it is written to LiveKit room
 * metadata, so the partner's browser (which can read `room.metadata`) only ever sees an opaque blob. It no longer
 * carries the owner's key terms, context prompt or voice — those go to the worker through the dispatch metadata
 * (see WorkerConfig), which participants never receive.
 */
export interface RoomMetadata {
  /** The owner's USER id. Server-side only (sealed) — never a LiveKit identity, never in a link. */
  ownerIdentity: string
  /** B16: the owner's opaque, per-room LiveKit participant identity (HMAC of user id + room). */
  ownerParticipant?: string
  conversationId: string
  generation: number
  mode: 'tabletop' | 'partner-link' | 'remote'
  maxSessionMinutes: number
  /** B3/B4: server-set bookkeeping so ANY serverless instance can settle/close this room. */
  startedAt?: number
  sttMinutes?: number
  sttReservationId?: string | null
  /**
   * The owner's live pair code, stored HMAC-hashed (never in clear) so /api/phone/bind on ANY instance can find it.
   * The whole object is sealed, so participants cannot even see the hash.
   */
  phonePair?: { codeHash: string; expiresAt: number; attempts: number } | null
  /** B17: ids of invites already consumed (fallback single-use store when the durable `consume_invite` RPC is unavailable). */
  usedInvites?: string[]
  /** Minutes reserved for an in-progress inbound call (settled by /api/phone/usage on any instance). */
  phoneCall?: { identity: string; minutes: number; month: string; at: number } | null
  /** @deprecated B16: no longer written (moved to WorkerConfig). Kept optional so old readers/tests still type-check. */
  voiceId?: string
  outputLanguage?: string
  inputLanguages?: string[]
  keyterms?: string[]
  contextPrompt?: string
}

/** B16: delivered ONLY to the worker job (agent dispatch metadata) — never visible to room participants. */
export interface WorkerConfig {
  /** The owner's LiveKit participant identity (opaque). Control messages are accepted only from it. */
  ownerIdentity: string
  /** The owner's user id: what approvals are signed for (`sub`). */
  ownerSub: string
  conversationId: string
  generation: number
  mode: RoomMetadata['mode']
  voiceId: string
  outputLanguage: string
  inputLanguages: string[]
  keyterms: string[]
  contextPrompt?: string
  maxSessionMinutes: number
}

/** B16: the owner's LiveKit identity is opaque and per-room, so the partner never learns the user id. */
export async function ownerParticipantIdentity(userId: string, room: string): Promise<string> {
  return `o-${(await hmacSha256Hex(env.approvalSecret(), `owner-identity:${room}:${userId}`)).slice(0, 24)}`
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

/**
 * Create the room and dispatch the worker.
 *  - room metadata  = SEALED server bookkeeping (opaque to participants);
 *  - dispatch metadata = the worker's private configuration (never sent to participants).
 */
export async function createRoomAndDispatch(room: string, meta: RoomMetadata, worker: WorkerConfig) {
  const host = hostUrl()
  const rs = new RoomServiceClient(host, env.livekitKey()!, env.livekitSecret()!)
  await rs.createRoom({
    name: room,
    emptyTimeout: 120,
    departureTimeout: 30,
    maxParticipants: 4,
    metadata: await sealRoomMeta(env.approvalSecret(), room, meta),
  })
  const dispatch = new AgentDispatchClient(host, env.livekitKey()!, env.livekitSecret()!)
  await dispatch.createDispatch(room, env.livekitAgentName(), { metadata: JSON.stringify(worker) })
}

export async function deleteRoom(room: string) {
  const rs = new RoomServiceClient(hostUrl(), env.livekitKey()!, env.livekitSecret()!)
  await rs.deleteRoom(room).catch(() => undefined)
}

/** Opens sealed room metadata. Plaintext / foreign / tampered metadata is NOT trusted (returns null). */
export async function readRoomMeta(room: string, raw: string | undefined): Promise<RoomMetadata | null> {
  const m = await openRoomMeta<RoomMetadata>(env.approvalSecret(), room, raw)
  return m && typeof m.ownerIdentity === 'string' && typeof m.conversationId === 'string' ? m : null
}

/**
 * B4: LiveKit is the cross-instance source of truth for which rooms exist and who owns them
 * (metadata is set server-side only at creation). Returns null if the room does not exist.
 */
export async function getRoomMeta(room: string): Promise<RoomMetadata | null> {
  const rs = new RoomServiceClient(hostUrl(), env.livekitKey()!, env.livekitSecret()!)
  const rooms = await rs.listRooms([room])
  const r = rooms.find((x) => x.name === room)
  return r ? readRoomMeta(room, r.metadata) : null
}

/** B4: all live owner rooms of a user (used to enforce one active conversation per user across instances). */
export async function listOwnerRooms(userId: string): Promise<{ room: string; meta: RoomMetadata }[]> {
  return (await listAllOwnerRooms()).filter((x) => x.meta.ownerIdentity === userId)
}

/** Replace a room's server-set metadata (read-modify-write callers only; see phone-store.ts). Always sealed. */
export async function updateRoomMeta(room: string, meta: RoomMetadata): Promise<void> {
  const rs = new RoomServiceClient(hostUrl(), env.livekitKey()!, env.livekitSecret()!)
  await rs.updateRoomMetadata(room, await sealRoomMeta(env.approvalSecret(), room, meta))
}

/** All live ReVOICE owner rooms with valid (sealed) metadata (any owner). */
export async function listAllOwnerRooms(): Promise<{ room: string; meta: RoomMetadata }[]> {
  const rs = new RoomServiceClient(hostUrl(), env.livekitKey()!, env.livekitSecret()!)
  const out: { room: string; meta: RoomMetadata }[] = []
  for (const r of await rs.listRooms()) {
    if (!r.name.startsWith('rv-')) continue
    const m = await readRoomMeta(r.name, r.metadata)
    if (m) out.push({ room: r.name, meta: m })
  }
  return out
}

/**
 * B17: partner invites.
 *   rvi1.<room>.<jti>.<exp>.<sig>     sig = HMAC(secret, "invite:<room>:<jti>:<exp>:<owner user id>")
 *  - the link carries NO user id (the owner is bound into the signature and recovered from the sealed room metadata);
 *  - every invite has a random id (`jti`) that /api/livekit/join consumes ATOMICALLY (single use, any instance);
 *  - the owner mints a fresh invite for each additional partner (/api/livekit/invite).
 */
export const INVITE_PREFIX = 'rvi1'

export async function signInvite(room: string, ownerUserId: string, now = Date.now()) {
  const jti = randomId(12)
  const exp = now + INVITE_TTL_MS
  const sig = await hmacSha256Hex(env.approvalSecret(), `invite:${room}:${jti}:${exp}:${ownerUserId}`)
  return { invite: `${INVITE_PREFIX}.${room}.${jti}.${exp}.${sig}`, jti, exp }
}

/** Syntax only — NOT trusted until verifyInvite() succeeds with the owner read from the room. */
export function parseInvite(invite: string): { room: string; jti: string; exp: number; sig: string } | null {
  const parts = invite.split('.')
  if (parts.length !== 5 || parts[0] !== INVITE_PREFIX) return null
  const [, room, jti, expS, sig] = parts
  const exp = Number(expS)
  if (!ROOM_RE.test(room) || !/^[a-f0-9]{24}$/.test(jti) || !Number.isFinite(exp) || !/^[a-f0-9]{64}$/.test(sig)) return null
  return { room, jti, exp, sig }
}

export async function verifyInvite(invite: string, ownerUserId: string, now = Date.now()): Promise<{ room: string; jti: string; exp: number } | null> {
  const p = parseInvite(invite)
  if (!p || now > p.exp) return null
  const expected = await hmacSha256Hex(env.approvalSecret(), `invite:${p.room}:${p.jti}:${p.exp}:${ownerUserId}`)
  return timingSafeEqualHex(expected, p.sig) ? { room: p.room, jti: p.jti, exp: p.exp } : null
}
