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

export const api = {
  status: () => call<StatusResponse>('/api/status'),
  approve: (req: ApproveRequest, voice?: ClonedVoiceProfile) =>
    call<{ approval: Approval }>('/api/approve', {
      method: 'POST',
      body: JSON.stringify({
        ...req,
        voice: voice && {
          voiceId: voice.voiceId,
          region: voice.region,
          consentAt: voice.consentAt,
          providerExpiresAt: voice.providerExpiresAt,
          revoked: voice.revoked,
          speakerConsent: voice.speakerConsent,
          rightsConfirmed: voice.rightsConfirmed,
          biometricTermsAccepted: voice.biometricTermsAccepted,
        },
      }),
    }),
  suggest: (req: SuggestRequest, signal?: AbortSignal) => call<{ set: CandidateSet }>('/api/suggest', { method: 'POST', body: JSON.stringify(req), signal }),
  startSession: (b: { mode: string; voiceId: string; outputLanguage: string; inputLanguages: string[]; keyterms: string[]; minutes?: number }) =>
    call<{ url: string; token: string; room: string; conversationId: string; invite: string | null; maxSessionMinutes: number }>('/api/livekit/session', { method: 'POST', body: JSON.stringify(b) }),
  endSession: (room: string) => call<{ ok: true }>('/api/livekit/end', { method: 'POST', body: JSON.stringify({ room }) }),
  join: (invite: string, label: string) => call<{ url: string; token: string; identity: string; room: string }>('/api/livekit/join', { method: 'POST', body: JSON.stringify({ invite, label, consent: true }) }),
  sttToken: (b: { sampleRate: number; languageCodes: string[]; keyterms: string[]; minutes: number }) =>
    call<{ wsUrl: string; maxSessionSeconds: number }>('/api/stt-token', { method: 'POST', body: JSON.stringify(b) }),
  renewConsent: (voiceId: string, affirmation: string) =>
    call<{ ok: true; providerExpiresAt: number | null }>('/api/voices/renew', { method: 'POST', body: JSON.stringify({ voiceId, affirmation, speakerIsOwner: true }) }),
  exportServer: () => call<Record<string, unknown>>('/api/account/export'),
  deleteServer: () => call<{ ok: true; thirdPartyActions: string[] }>('/api/account/delete', { method: 'POST', body: '{}' }),
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

export interface StatusResponse {
  identity: { userId: string; kind: 'supabase' | 'local-demo' }
  providers: {
    assemblyai: boolean; groq: boolean; livekit: boolean; supabase: boolean; durableStore: boolean
    browserStt: boolean; approvalSecretConfigured: boolean; region: 'us' | 'eu'; groqModel: string
  }
  budget: {
    user: BudgetSnap
    project: BudgetSnap
  }
}
export interface BudgetSnap {
  day: string
  groq: { requests: number; requestsLimit: number; tokens: number; tokensLimit: number; retryAfterUntil: number }
  tts: { chars: number; charsLimit: number }
  stt: { minutes: number; minutesLimit: number }
  usd: { today: number; todayLimit: number; lifetime: number; spendable: number }
}
