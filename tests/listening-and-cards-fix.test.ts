/**
 * Regression tests for the two reported TODOs:
 *  1. "Could not start listening (stt daily minutes)" — a hard 40 min/day cap plus reservations that were never refunded on a
 *     different serverless instance locked visitors out after two or three tries.
 *  2. Suggestion cards could not be clicked / applied to the composer (the button was `disabled` while the Conversation Brake
 *     flagged the set stale, and the brake fired on harmless partial -> formatted-final changes like "seven" -> "7").
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BudgetLedger, dayKey, LIMITS, STT_DAILY_MINUTES_CAP } from '@/lib/budget'
import { materialChange } from '@/lib/turns'
import { Suggestions } from '@/components/Suggestions'
import type { CandidateSet } from '@/lib/contracts'

const T0 = Date.parse('2026-11-07T10:00:00Z')

describe('TODO 1 — listening quota', () => {
  it('has no daily minute cap by default (0 = unlimited)', () => {
    expect(STT_DAILY_MINUTES_CAP).toBe(0)
    expect(LIMITS.assembly.dailyFlagshipListeningMinutes).toBe(0)
  })
  it('ten start/stop cycles never produce stt_daily_minutes', () => {
    const l = new BudgetLedger()
    for (let i = 0; i < 10; i++) {
      const r = l.reserveSttMinutes(20, T0)
      expect(r.ok).toBe(true)
      if (r.ok) l.releaseSttMinutes(r.minutes, 1, dayKey(T0), T0)
    }
    expect(l.snapshot(T0).stt.minutes).toBe(10)
  })
  it('a ticket-based refund works on an instance that did not make the reservation', async () => {
    const st = await import('@/lib/server/state')
    const user = 'user-quota-fix'
    const room = 'sd-aaaaaaaaaaaaaaaaaaaaaaaa'
    st.ledgerFor(user).reserveSttMinutes(20, T0)
    expect(st.ledgerFor(user).snapshot(T0).stt.minutes).toBe(20)
    // no cached session for this user/room (a different instance handled /end) → refund from the signed ticket's numbers
    expect(st.settleLocalStt(user, room, 2, T0, { sttMinutes: 20, sttDay: dayKey(T0) })).toBe(true)
    expect(st.ledgerFor(user).snapshot(T0).stt.minutes).toBe(2)
    expect(st.settleLocalStt(user, room, 2, T0, { sttMinutes: 20, sttDay: dayKey(T0) })).toBe(false) // idempotent
  })
  it('resetSttLedgers clears reservations', async () => {
    const st = await import('@/lib/server/state')
    st.ledgerFor('user-reset').reserveSttMinutes(20, Date.now())
    const r = st.resetSttLedgers()
    expect(r.cleared).toBeGreaterThanOrEqual(20)
    expect(st.ledgerFor('user-reset').snapshot().stt.minutes).toBe(0)
  })
})

describe('TODO 2 — suggestion cards', () => {
  const set: CandidateSet = {
    id: 'set1',
    turn: { conversationId: 'c1', generation: 0, turnId: 0, revision: 0, transcriptHash: 'a'.repeat(64) },
    status: 'final',
    outputLanguage: 'english',
    voiceId: 'aai-audrey',
    createdAt: T0,
    expiresAt: T0 + 60_000,
    candidates: [
      { id: 'c-a', text: 'Sounds good to me.', intent: 'continue', risk: 'none' },
      { id: 'c-b', text: 'What time were you thinking?', intent: 'clarify', risk: 'none' },
      { id: 'c-c', text: 'I cannot make it, sorry.', intent: 'decline', risk: 'none' },
    ],
  }
  const render = (stale: string | null) =>
    renderToStaticMarkup(
      createElement(Suggestions, {
        set, pending: null, stale, loading: false, error: null, passport: null,
        onEngage: () => {}, onUse: () => {}, onAcceptPending: () => {}, onFeedback: () => {}, onRegenerate: () => {},
        redraftsLeft: 2, redraftLimit: 2, preferredIntent: '', setPreferredIntent: () => {},
      }),
    )

  it('every "Use" button is enabled when the set is fresh', () => {
    const html = render(null)
    const buttons = html.match(/<button[^>]*data-testid="use-suggestion"[^>]*>/g) ?? []
    expect(buttons).toHaveLength(3)
    for (const b of buttons) expect(b).not.toMatch(/disabled/)
  })
  it('every "Use" button stays enabled when the set is stale (it used to be disabled)', () => {
    const html = render('number_or_date')
    const buttons = html.match(/<button[^>]*data-testid="use-suggestion"[^>]*>/g) ?? []
    expect(buttons).toHaveLength(3)
    for (const b of buttons) expect(b).not.toMatch(/disabled/)
    expect(html).toContain('Use anyway (edit first)')
  })
  it('partial -> formatted final of the same words is NOT a material change', () => {
    expect(materialChange("Are you free for dinner on Friday? I was thinking about seven o'clock", "Are you free for dinner on Friday? I was thinking about 7 o'clock.")).toBeNull()
    expect(materialChange('meet at 7:00', 'meet at 7')).toBeNull()
    expect(materialChange('I have two tickets', 'I have 2 tickets.')).toBeNull()
  })
  it('real changes still trip the Conversation Brake', () => {
    expect(materialChange('are you free on friday', "are you not free on friday")).toBe('negation')
    expect(materialChange('dinner at seven', 'dinner at eight')).toBe('number_or_date')
    expect(materialChange('dinner at 7', 'dinner at 8')).toBe('number_or_date')
  })
})
