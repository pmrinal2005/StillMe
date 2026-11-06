/**
 * D #33/#34 — tell the client when a request was NOT served as the account it expected.
 *
 * Before: a request with no token was always a guest, and an invalid/expired token was a hard 401. A signed-in user
 * whose token was briefly missing silently ran on guest limits, and one stale token broke even the guest features.
 *
 * Now the server keeps working (guest fallback) but labels the response with `x-revoice-auth: <note>` so the client can
 * refresh the session, retry once, sign out locally if it cannot be recovered, and TELL the user.
 */
export type AuthNote = 'invalid_token' | 'missing_token' | 'auth_unavailable'

export const AUTH_NOTE_HEADER = 'x-revoice-auth'
/** Sent by the browser when it believes it is signed in but could not produce an access token. */
export const EXPECT_ACCOUNT_HEADER = 'x-revoice-expect-account'

const notes = new WeakMap<Request, AuthNote>()

export function setAuthNote(req: Request, note: AuthNote): void {
  notes.set(req, note)
}

export function authNoteFor(req: unknown): AuthNote | undefined {
  return req instanceof Request ? notes.get(req) : undefined
}
