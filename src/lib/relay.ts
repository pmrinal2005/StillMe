/** Pure validation for the partner-phone relay (shared by the owner and partner pages; unit-tested). */
export const ASSEMBLYAI_WS_RE = /^wss:\/\/streaming(?:\.eu)?\.assemblyai\.com\/v3\/ws\?/

/** A partner phone only ever opens a WebSocket to AssemblyAI streaming. A forged command must not point its mic elsewhere. */
export const isAssemblyStreamingUrl = (u: string): boolean => ASSEMBLYAI_WS_RE.test(u)

interface PeerLike { identity: string; isAgent?: boolean; attributes?: Record<string, string> }

/** Relay commands are accepted by a partner ONLY from the room's owner (server-signed `role=owner` attribute, never an agent). */
export const isOwnerPeer = (p: PeerLike | undefined | null): boolean => !!p && !p.isAgent && p.attributes?.role === 'owner'

/** Relay turns are accepted by the owner ONLY from partner participants (server-signed `role=partner`, identity `partner-…`). */
export const isPartnerPeer = (p: PeerLike | undefined | null): boolean => !!p && !p.isAgent && /^partner-/.test(p.identity) && p.attributes?.role === 'partner'

/** Turn ids from a restarted relay stream restart at 0: offset each relay session so a new stream never overwrites old turns. */
export const RELAY_TURN_STRIDE = 10_000
