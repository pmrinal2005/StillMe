import 'server-only'
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk'
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
  maxSessionMinutes: number
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
    canPublishSources: opts.mode === 'tabletop' ? ['microphone' as never] : [],
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
    canPublishSources: ['microphone' as never],
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
