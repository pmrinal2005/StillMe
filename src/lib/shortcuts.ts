/**
 * Small pure helpers behind D #40-#42 (kept out of the React component so they are unit-tested).
 */

/**
 * D #41 — what Ctrl/Cmd+Enter may do.
 *
 * Bug: the shortcut called speak() unconditionally. While the "Speak exactly this?" confirmation dialog was open it
 * bypassed the confirmation step (and, with the dialog's own button, requested the same message twice).
 * Now the shortcut is inert while the dialog is showing (the dialog's own buttons are the only way through it), when there
 * is nothing to say, or while a previous request is still being approved.
 */
export function ctrlEnterAction(s: { confirming: boolean; text: string; requestInFlight: boolean }): 'speak' | 'ignore' {
  if (s.confirming || s.requestInFlight) return 'ignore'
  return s.text.trim().length > 0 ? 'speak' : 'ignore'
}

/** D #42 — whole minutes elapsed, never negative, never past the cap the UI shows. */
export function elapsedMinutes(startedAt: number, now: number, maxMinutes = Infinity): number {
  return Math.min(Math.max(0, Math.floor((now - startedAt) / 60_000)), maxMinutes)
}

/**
 * D #40 — has a HELD approval run out?
 *
 * Bug: the approval's expiry (`exp`) is stamped by the SERVER clock but was compared against the DEVICE clock, so a phone
 * whose clock was minutes off expired a held message immediately (clock ahead) or let it be spoken after the server would
 * refuse it (clock behind).
 * Now only DURATIONS measured on the device are used: how long we have held it (device elapsed) against the approval's own
 * server-defined lifetime (`exp - iat`, both server timestamps, so any clock offset cancels out) and the hold cap.
 */
export const HOLD_EXPIRY_SLACK_MS = 2_000
export function heldApprovalExpired(approval: { iat: number; exp: number }, heldAtMs: number, nowMs: number, maxHoldMs: number): boolean {
  const elapsed = nowMs - heldAtMs
  const lifetime = approval.exp - approval.iat
  return elapsed > maxHoldMs || elapsed > lifetime - HOLD_EXPIRY_SLACK_MS
}
