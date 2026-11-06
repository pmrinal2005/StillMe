/**
 * D #35 — what to do with a user's EXISTING listening room(s) when they start a new one.
 *
 * Bug: the client always sent `replace: true`, so starting a session on one device silently ended the session the user was
 * running on another device (mid-conversation, with no warning).
 *
 * Now `replace` means "I have been told and I agree to end sessions that THIS device does not hold": a room whose signed
 * session ticket the caller presented is this device's own (a stale/leaked earlier session of its own) and is replaced
 * without a prompt; any other room is a conflict (`409 session_active`, `otherDevice: true`) until the caller re-sends with
 * `replace: true`. Pure so it is unit-tested without LiveKit.
 */
export interface ExistingRoom {
  room: string
  /** The presented session ticket is valid for this room and this user (this device started it). */
  mine: boolean
}

export type ReplacePlan =
  | { action: 'none' }
  | { action: 'replace'; rooms: string[] }
  | { action: 'conflict'; room: string; otherDevice: boolean }

export function planExistingSessions(existing: ExistingRoom[], replace: boolean): ReplacePlan {
  if (!existing.length) return { action: 'none' }
  const foreign = existing.filter((r) => !r.mine)
  if (!foreign.length) return { action: 'replace', rooms: existing.map((r) => r.room) }
  if (replace) return { action: 'replace', rooms: existing.map((r) => r.room) }
  return { action: 'conflict', room: foreign[0].room, otherDevice: true }
}
