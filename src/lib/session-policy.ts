/**
 * Mode-aware session policy shared by the browser, the API routes and (mirrored byte-for-byte in
 * worker/revoice_worker/config.py) the Python worker. Pure; unit-tested.
 *
 * Why this exists: partner-link / remote sessions used to be killed by rules written for a single device on a table:
 *   - the owner's page switching tabs or locking the phone (pagehide) ended the room, dropping the partner,
 *   - a missing voice worker ended the room after 45 s even though the partner's phone could do the transcription,
 *   - the worker closed the room 30 s after the owner's connection blinked.
 */
export type ConversationMode = 'tabletop' | 'partner-link' | 'remote'

/** LiveKit room timeouts (seconds). A partner needs time to open the link; a reloading phone must not close the room. */
export function roomTimeouts(mode: ConversationMode): { emptyTimeout: number; departureTimeout: number } {
  return mode === 'tabletop' ? { emptyTimeout: 120, departureTimeout: 30 } : { emptyTimeout: 300, departureTimeout: 120 }
}

/** How long the worker waits for a vanished owner before ending the room. MUST equal worker `owner_gone_grace_s`. */
export const OWNER_GONE_GRACE_S = { tabletop: 30, 'partner-link': 120, remote: 120 } as const
export const ownerGoneGraceSeconds = (mode: ConversationMode): number => OWNER_GONE_GRACE_S[mode] ?? OWNER_GONE_GRACE_S.tabletop

/**
 * Owner page going to the background.
 *  tabletop       the microphone stops when the page is hidden, so listening cannot continue: end on pagehide, 3 min hidden.
 *  partner-link / remote   the partner is still talking: pagehide must NOT end the room. The worker's owner-gone grace (and the
 *                 room's departure timeout) close it if the owner never comes back. Hidden-tab limit is 10 minutes.
 */
export function backgroundPolicy(mode: ConversationMode): { pagehideEnds: boolean; hiddenEndMs: number } {
  return mode === 'tabletop' ? { pagehideEnds: true, hiddenEndMs: 3 * 60_000 } : { pagehideEnds: false, hiddenEndMs: 10 * 60_000 }
}

export type AbsentAction = 'fallback_direct' | 'relay' | 'keep' | 'end'

/**
 * The voice worker never joined (or left and did not return). What now?
 *  tabletop       listen on this device (browser STT) if available, otherwise release the room.
 *  partner-link / remote   NEVER auto-kill: the partner's phone relays captions (browser STT) when available, otherwise the
 *                 session stays open for typed speech and the owner is told captions are unavailable.
 */
export function workerAbsentAction(mode: ConversationMode, browserStt: boolean): AbsentAction {
  if (mode === 'tabletop') return browserStt ? 'fallback_direct' : 'end'
  return browserStt ? 'relay' : 'keep'
}

export type RelayWorkerState = 'connecting' | 'waiting' | 'ready' | 'absent' | 'lost' | 'degraded'

/**
 * Should the partner's phone be transcribing right now? Only when NO worker is transcribing (never two paid streams on the
 * same audio), a partner is actually in the room and the owner may use browser STT.
 */
export function relayDesired(o: { mode: ConversationMode; workerState: RelayWorkerState | null | undefined; partnerPresent: boolean; browserStt: boolean }): boolean {
  if (o.mode === 'tabletop' || !o.browserStt || !o.partnerPresent) return false
  return o.workerState === 'absent' || o.workerState === 'lost'
}
