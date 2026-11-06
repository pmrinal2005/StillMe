/**
 * B18 — what /api/status may reveal.
 *
 * Bug: /api/status answered ANY caller with the caller's internal user id, the
 * project-wide budget (how much of the shared AssemblyAI credit is left, lifetime and spendable USD), every cap, the
 * spend-store schema mode, the approval-secret SOURCE (tells an attacker which provider secret derives the HMAC key)
 * and the Groq model. That is reconnaissance material for anyone who opens the site.
 *
 * Now: the public view is the minimum the UI needs to render (feature flags, region, the CALLER's own daily meters and
 * the session length cap — no user id). Everything operational lives under `operator`, present
 * only for an operator (fail-closed token, see auth.ts isOperator).
 */
import type { BudgetLedger } from './budget'

type BudgetSnapshot = ReturnType<BudgetLedger['snapshot']>

export interface PublicStatus {
  providers: {
    assemblyai: boolean
    groq: boolean
    livekit: boolean
    durableStore: boolean
    browserStt: boolean
    phoneInbound: boolean
    approvalSecretConfigured: boolean
    region: 'us' | 'eu'
  }
  budget: { user: UserMeters; limits: { assembly: { interactiveSessionMinutes: number }; livekit: { monthlyInboundPhoneMinutes: number } } }
  operator?: unknown
}

/** The caller's own daily meters. No lifetime figure and no shared-credit "spendable" total. */
export interface UserMeters {
  day: string
  groq: { requests: number; requestsLimit: number; tokens: number; tokensLimit: number; retryAfterUntil: number }
  tts: { chars: number; charsLimit: number }
  stt: { minutes: number; minutesLimit: number }
  usd: { today: number; todayLimit: number }
}

export function userMeters(s: BudgetSnapshot): UserMeters {
  return { day: s.day, groq: s.groq, tts: s.tts, stt: s.stt, usd: { today: s.usd.today, todayLimit: s.usd.todayLimit } }
}

/** Keys that must NEVER appear in a non-operator response (asserted by tests). */
export const OPERATOR_ONLY_KEYS = ['userId', 'project', 'spendStore', 'approvalSecretSource', 'groqModel', 'lifetime', 'spendable', 'totalCreditUsd', 'protectedReserveUsd', 'dailyUsd'] as const
