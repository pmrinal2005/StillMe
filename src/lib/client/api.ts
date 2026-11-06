'use client'
import type { Approval, ApproveRequest, CandidateSet, SuggestRequest } from '../contracts'
import type { ClonedVoiceProfile } from '../voices'
import { getSupabase } from './supabase'

/**
 * D #33/#34 — client side of the guest-fallback protocol (see src/lib/server/auth-note.ts).
 *
 * The server now answers a request whose token was missing/invalid/unverifiable as a CAPPED GUEST and labels the response
 * with `x-revoice-auth`. Here we (a) tell the server when we believe we are signed in (so a lost token is detected, not
 * silently downgraded), (b) refresh the session and retry ONCE when the token was rejected, (c) sign out locally when the
 * refresh token is dead (so one stale token can never break speech again), and (d) tell the user what happened.
 */
export type AuthProblem = { kind: 'expired' | 'missing' | 'unavailable'; signedOut: boolean }
type AuthProblemListener = (p: AuthProblem) => void
const problemListeners = new Set<AuthProblemListener>()
export function onAuthProblem(cb: AuthProblemListener): () => void {
  problemListeners.add(cb)
  return () => problemListeners.delete(cb)
}
const lastEmitted = new Map<string, number>()
export const AUTH_PROBLEM_THROTTLE_MS = 30_000
function emitProblem(p: AuthProblem, now = Date.now()) {
  const last = lastEmitted.get(p.kind) ?? 0
  if (now - last < AUTH_PROBLEM_THROTTLE_MS) return
  lastEmitted.set(p.kind, now)
  for (const cb of problemListeners) cb(p)
}

/** Do we believe this browser holds a signed-in (non-guest) account right now? */
let believesSignedIn = false
let watching = false
function watchAuth() {
  if (watching) return
  const sb = getSupabase()
  if (!sb) return
  watching = true
  void sb.auth.getSession().then(({ data }) => {
    if (data.session) believesSignedIn = true
  }).catch(() => undefined)
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') believesSignedIn = false
    else if (session) believesSignedIn = true
  })
}

async function authHeaders(): Promise<Record<string, string>> {
  const sb = getSupabase()
  if (!sb) return {}
  watchAuth()
  let session = null
  try {
    session = (await sb.auth.getSession()).data.session
  } catch {
    session = null
  }
  if (session) return { authorization: `Bearer ${session.access_token}` }
  // No token. If we believe we were signed in, say so: the server then labels the guest fallback instead of hiding it.
  return believesSignedIn ? { 'x-revoice-expect-account': '1' } : {}
}

/** Terminal refresh failures (the refresh token is dead) vs. transient ones (offline, Supabase down, rate limited). */
export function isTerminalRefreshError(e: { name?: string; status?: number; code?: string } | null | undefined): boolean {
  if (!e) return false
  if (e.name === 'AuthRetryableFetchError') return false
  if (e.name === 'AuthSessionMissingError' || e.name === 'AuthInvalidTokenResponseError') return true
  if (e.code === 'refresh_token_not_found' || e.code === 'refresh_token_already_used' || e.code === 'session_not_found' || e.code === 'bad_jwt') return true
  const st = e.status
  return typeof st === 'number' && st >= 400 && st < 500 && st !== 429 && st !== 408
}

let refreshing: Promise<'retry' | 'none'> | null = null

/** Returns 'retry' when a (new) valid token is now available and the request should be repeated once. */
export function recoverAuth(note: string, usedToken: string | null): Promise<'retry' | 'none'> {
  if (refreshing) return refreshing
  refreshing = (async (): Promise<'retry' | 'none'> => {
    const sb = getSupabase()
    if (!sb) return 'none'
    if (note === 'auth_unavailable') {
      emitProblem({ kind: 'unavailable', signedOut: false })
      return 'none'
    }
    // missing_token: maybe the session simply was not readable a moment ago.
    if (note === 'missing_token') {
      const cur = (await sb.auth.getSession().catch(() => ({ data: { session: null } }))).data.session
      if (cur) return 'retry'
    }
    const r = await sb.auth.refreshSession().catch((e: unknown) => ({ data: { session: null }, error: e as { name?: string; status?: number; code?: string } }))
    const fresh = r.data?.session
    if (fresh && fresh.access_token !== usedToken) return 'retry'
    const err = 'error' in r ? (r.error as { name?: string; status?: number; code?: string } | null) : null
    if (!fresh && isTerminalRefreshError(err) || (!fresh && !err && note === 'invalid_token')) {
      // The stored session is dead: clear it locally so it cannot keep poisoning requests, then tell the user.
      await sb.auth.signOut({ scope: 'local' }).catch(() => undefined)
      believesSignedIn = false
      emitProblem({ kind: 'expired', signedOut: true })
      return 'none'
    }
    emitProblem({ kind: note === 'missing_token' ? 'missing' : 'unavailable', signedOut: false })
    return 'none'
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}

const bearerOf = (h: Record<string, string>) => (h.authorization?.startsWith('Bearer ') ? h.authorization.slice(7) : null)

/**
 * fetch + auth: attaches the session token and, when the server reports a guest FALLBACK for this request, refreshes the
 * session and repeats the request once with the new token. Never loops.
 */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const send = async () => {
    const h = await authHeaders()
    const res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...h, ...(init.headers ?? {}) },
    })
    return { res, token: bearerOf(h) }
  }
  const first = await send()
  const note = first.res.headers.get('x-revoice-auth')
  if (!note) return first.res
  const verdict = await recoverAuth(note, first.token)
  if (verdict !== 'retry') return first.res
  first.res.body?.cancel().catch(() => undefined)
  return (await send()).res
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: Record<string, unknown> = {}) {
    super(code)
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authedFetch(path, init)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, (body.reason as string) ?? (body.error as string) ?? `http_${res.status}`, body)
  }
  return res.json() as Promise<T>
}

/** B4: signed session ticket from /api/livekit/session, presented on session-scoped requests. */
let sessionTicket: string | null = null
export function setSessionTicket(t: string | null) {
  sessionTicket = t
}
export const getSessionTicket = () => sessionTicket
const ticketHeader = (): Record<string, string> => (sessionTicket ? { 'x-revoice-session': sessionTicket } : {})

export const api = {
  status: () => call<StatusResponse>('/api/status'),
  /** B11: the server decides voice authorization from its own registry; the client sends no consent attestation. */
  approve: (req: ApproveRequest, _voice?: ClonedVoiceProfile) =>
    call<{ approval: Approval }>('/api/approve', {
      method: 'POST',
      headers: req.roomName ? ticketHeader() : {},
      body: JSON.stringify(req),
    }),
  suggest: (req: SuggestRequest, signal?: AbortSignal) => call<{ set: CandidateSet }>('/api/suggest', { method: 'POST', body: JSON.stringify(req), signal }),
  startSession: (b: { mode: string; voiceId: string; outputLanguage: string; inputLanguages: string[]; keyterms: string[]; contextPrompt?: string; minutes?: number; replace?: boolean }) =>
    call<{ url: string; token: string; room: string; conversationId: string; invite: string | null; ticket: string; maxSessionMinutes: number }>('/api/livekit/session', {
      method: 'POST',
      body: JSON.stringify({ ...b, ticket: sessionTicket ?? undefined }),
    }),
  endSession: (room: string, reason: 'user' | 'timeout' | 'budget' | 'idle' | 'error' = 'user', ticket: string | null = sessionTicket) =>
    call<{ ok: true; minutesUsed?: number }>('/api/livekit/end', { method: 'POST', body: JSON.stringify({ room, reason, ticket: ticket ?? undefined }) }),
  join: (invite: string, label: string) => call<{ url: string; token: string; identity: string; room: string }>('/api/livekit/join', { method: 'POST', body: JSON.stringify({ invite, label, consent: true }) }),
  sttToken: (b: { sampleRate: number; languageCodes: string[]; keyterms: string[]; minutes: number }) =>
    call<{ wsUrl: string; maxSessionSeconds: number; session?: string; ticket?: string }>('/api/stt-token', { method: 'POST', body: JSON.stringify(b) }),
  renewConsent: (voiceId: string, affirmation: string, outputLanguage?: string) =>
    call<{ ok: true; providerExpiresAt: number | null; voice?: ClonedVoiceProfile }>('/api/voices/renew', { method: 'POST', body: JSON.stringify({ voiceId, affirmation, speakerIsOwner: true, outputLanguage }) }),
  /** B11: server-side cloned-voice registry (the browser copy is only a cache of this). */
  voicesList: () => call<{ voices: ClonedVoiceProfile[]; region: 'us' | 'eu' }>('/api/voices'),
  voiceRegister: (b: {
    voiceId: string; label: string; ownerName: string; recordingLanguage: string; provenance: string; provenanceNote: string
    fallbackVoiceId: string; qualityChecked: true; speakerConsent: true; rightsConfirmed: true; biometricTermsAccepted: true
  }) => call<{ ok: true; voice: ClonedVoiceProfile }>('/api/voices', { method: 'POST', body: JSON.stringify(b) }),
  voiceRevoke: (voiceId: string) => call<{ ok: true; voice: ClonedVoiceProfile; thirdPartyActions: string[] }>('/api/voices/revoke', { method: 'POST', body: JSON.stringify({ voiceId }) }),
  /** B17: partner invites are single use — mint a fresh link for each additional partner. */
  newInvite: (room: string, ticket: string | null = sessionTicket) =>
    call<{ invite: string; expiresAt: number }>('/api/livekit/invite', { method: 'POST', body: JSON.stringify({ room, ticket: ticket ?? undefined }) }),
  phonePair: () => call<{ code: string; expiresAt: number; number: string | null; maxCallMinutes: number; monthUsed: number; monthCap: number }>('/api/phone/pair', { method: 'POST', body: '{}', headers: ticketHeader() }),
  phoneRevoke: () => call<{ ok: true }>('/api/phone/pair', { method: 'DELETE' }),
  reconcileGet: () => call<{ estimate: { source: string; assemblyaiUsd: number; phone: { month: string; minutesUsed: number; cap: number } }; recorded: { provider: string; periodStart: string; periodEnd: string; providerReportedUsd: number | null; note: string; at: number }[]; assemblyai: { status: string; driftUsd: number | null } | null }>('/api/reconcile'),
  reconcilePost: (b: { provider: string; periodStart: string; periodEnd: string; providerReportedUsd: number | null; note?: string }) => call<{ ok: true; result: { status: string; driftUsd: number | null } | null }>('/api/reconcile', { method: 'POST', body: JSON.stringify(b) }),
  exportServer: () => call<Record<string, unknown>>('/api/account/export'),
  /** B19: real deletion; the server requires the typed confirmation in the body and reports every step. */
  deleteServer: () => call<{ ok: boolean; steps: { step: string; ok: boolean; detail?: string }[]; voicesTombstoned: number; thirdPartyActions: string[] }>('/api/account/delete', { method: 'POST', body: JSON.stringify({ confirm: 'DELETE MY ACCOUNT' }) }),
  /** Streams approved speech. Abort the signal to Stop (cancels upstream synthesis). */
  speakStream: async (approval: Approval, text: string, signal: AbortSignal) => {
    const res = await authedFetch('/api/speak', { method: 'POST', signal, body: JSON.stringify({ approval, text }) })
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}))
      throw new ApiError(res.status, (body.reason as string) ?? (body.error as string) ?? `http_${res.status}`, body)
    }
    return { body: res.body, sampleRate: Number(res.headers.get('x-revoice-sample-rate') ?? 24000), voiceExpiresAt: Number(res.headers.get('x-revoice-voice-expires-at')) || undefined }
  },
}

/** B18: the PUBLIC status shape (no user id, no project budget). Operators additionally get `operator`. */
export interface StatusResponse {
  identity: { kind: 'supabase' | 'local-demo' | 'guest' }
  providers: {
    assemblyai: boolean; groq: boolean; livekit: boolean; supabase: boolean; durableStore: boolean
    browserStt: boolean; phoneInbound?: boolean; approvalSecretConfigured: boolean; region: 'us' | 'eu'
  }
  budget: {
    user: BudgetSnap
    limits?: { assembly: { interactiveSessionMinutes: number }; livekit: { monthlyInboundPhoneMinutes: number } }
  }
  /** Present only for an operator. */
  operator?: { userId: string; spendStore: string; providers: Record<string, unknown>; budget: Record<string, unknown> }
}
export interface BudgetSnap {
  day: string
  groq: { requests: number; requestsLimit: number; tokens: number; tokensLimit: number; retryAfterUntil: number }
  tts: { chars: number; charsLimit: number }
  stt: { minutes: number; minutesLimit: number }
  usd: { today: number; todayLimit: number }
}
