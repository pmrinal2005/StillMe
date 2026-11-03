/**
 * B7 — Conversation-mode selection.
 *
 * Bug: the mode radio on the session panel was initialised to 'tabletop' with local state and never
 * read the saved `sessionMode` preference (nor saved a new choice), so the user's preferred mode was
 * silently ignored on every visit.
 *
 * Now the effective mode is derived from (saved preference, what the server can do):
 *  - partner-link / remote need LiveKit; if it is not configured they fall back to tabletop
 *    (the only mode the radio allows then) WITHOUT overwriting the saved preference, so the
 *    choice comes back once LiveKit is configured.
 *  - Unknown/corrupt stored values fall back to tabletop.
 */
export type SessionMode = 'tabletop' | 'partner-link' | 'remote'
export const SESSION_MODES: readonly SessionMode[] = ['tabletop', 'partner-link', 'remote'] as const

export function isSessionMode(v: unknown): v is SessionMode {
  return typeof v === 'string' && (SESSION_MODES as readonly string[]).includes(v)
}

export function modeAvailable(mode: SessionMode, livekitAvailable: boolean): boolean {
  return mode === 'tabletop' || livekitAvailable
}

/** The mode the radio should show / a new session should use. */
export function effectiveMode(saved: unknown, livekitAvailable: boolean): SessionMode {
  const m = isSessionMode(saved) ? saved : 'tabletop'
  return modeAvailable(m, livekitAvailable) ? m : 'tabletop'
}
