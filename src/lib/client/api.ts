'use client'
import type { Approval, ApproveRequest, CandidateSet, SuggestRequest } from '../contracts'
import type { ClonedVoiceProfile } from '../voices'
import { getSupabase } from './supabase'

async function authHeaders(): Promise<Record<string, string>> {
  const sb = getSupabase()
  if (!sb) return {}
  const { data } = await sb.auth.getSession()
  return data.session ? { authorization: `Bearer ${data.session.access_token}` } : {}
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: Record<string, unknown> = {}) {
    super(code)
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(await authHeaders()), ...(init.headers ?? {}) },
  })
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
    const res = await fetch('/api/speak', {
      method: 'POST',
      signal,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ approval, text }),
    })
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
