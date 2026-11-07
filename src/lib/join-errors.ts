/** Maps every error the partner join flow can produce to ONE plain-language message (no raw codes shown to a partner). */
export interface JoinErrorView { message: string; /** the link can never work again (do not offer Retry) */ fatal: boolean }

export function mapJoinError(code: string | undefined | null, status?: number): JoinErrorView {
  const c = String(code ?? '').toLowerCase()
  if (c === 'invite_invalid_or_expired' || c === 'invite_malformed') return { message: 'This invitation is invalid or has expired. Ask for a new link.', fatal: true }
  if (c === 'invite_used') return { message: 'This link was already used. If this is the same phone, reload this page to rejoin; otherwise ask for a new link.', fatal: false }
  if (c === 'claim_invalid_or_expired') return { message: 'Your place in this conversation has expired. Ask for a new link.', fatal: true }
  if (c === 'session_ended' || status === 410) return { message: 'This conversation has ended. Ask for a new link if you want to continue.', fatal: true }
  if (c === 'rate_limited' || status === 429) return { message: 'Too many attempts. Please wait a minute and try again.', fatal: false }
  if (c === 'invite_store_unavailable' || c === 'join_failed' || (status !== undefined && status >= 500 && status < 600)) return { message: 'Could not join right now. Your link is still valid. Please try again.', fatal: false }
  if (c === 'livekit_not_configured' || status === 503) return { message: 'Calling is not configured on this server.', fatal: true }
  if (c === 'invalid_request') return { message: 'Please tick the consent box before joining.', fatal: false }
  if (/permission|notallowed|denied/i.test(c)) return { message: 'Microphone permission is needed to talk. Allow it for this site, then press Join again.', fatal: false }
  if (/notfound|devices/i.test(c)) return { message: 'No microphone was found on this device.', fatal: false }
  if (/failed to fetch|networkerror|load failed|network/i.test(c)) return { message: 'No connection. Check your network and try again.', fatal: false }
  return { message: 'Could not join. Please try again.', fatal: false }
}
