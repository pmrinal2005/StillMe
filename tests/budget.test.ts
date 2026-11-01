import { describe, expect, it } from 'vitest'
import { BudgetLedger, LIMITS, PRICES, estimateAssemblyUsd } from '@/lib/budget'

const T0 = Date.parse('2026-11-01T10:00:00Z')

describe('cost formula', () => {
  it('matches the documented list prices', () => {
    expect(estimateAssemblyUsd({ flagshipHours: 2, ttsChars: 20_000 })).toBeCloseTo(1.2)
    expect(estimateAssemblyUsd({ flagshipHours: 8, ttsChars: 35_000 })).toBeCloseTo(4.125)
    expect(estimateAssemblyUsd({ economyHours: 1 })).toBeCloseTo(PRICES.sttEconomyPerHour)
  })
})

describe('Groq intersecting limits', () => {
  it('one outstanding generation per conversation', () => {
    const l = new BudgetLedger()
    const a = l.reserveGroq({ conversationId: 'c', turnKey: 'c:0:0', inputTokens: 100, now: T0 })
    expect(a.ok).toBe(true)
    const b = l.reserveGroq({ conversationId: 'c', turnKey: 'c:0:1', inputTokens: 100, now: T0 })
    expect(b).toMatchObject({ ok: false, reason: 'groq_outstanding' })
    if (a.ok) l.commitGroq(a.id, 300)
    expect(l.reserveGroq({ conversationId: 'c', turnKey: 'c:0:1', inputTokens: 100, now: T0 }).ok).toBe(true)
  })
  it('max two calls per partner turn', () => {
    const l = new BudgetLedger()
    for (let i = 0; i < 2; i++) {
      const r = l.reserveGroq({ conversationId: 'c', turnKey: 't', inputTokens: 10, now: T0 + i })
      if (r.ok) l.commitGroq(r.id)
    }
    expect(l.reserveGroq({ conversationId: 'c', turnKey: 't', inputTokens: 10, now: T0 + 5 })).toMatchObject({ ok: false, reason: 'groq_turn_cap' })
  })
  it('requests per minute, then recovers after the window', () => {
    const l = new BudgetLedger()
    for (let i = 0; i < LIMITS.groq.requestsPerMinute; i++) {
      const r = l.reserveGroq({ conversationId: 'c', turnKey: `t${i}`, inputTokens: 10, now: T0 + i })
      expect(r.ok).toBe(true)
      if (r.ok) l.commitGroq(r.id)
    }
    expect(l.reserveGroq({ conversationId: 'c', turnKey: 'tx', inputTokens: 10, now: T0 + 10 })).toMatchObject({ ok: false, reason: 'groq_rpm' })
    expect(l.reserveGroq({ conversationId: 'c', turnKey: 'tx', inputTokens: 10, now: T0 + 61_000 }).ok).toBe(true)
  })
  it('daily token budget binds before 200 requests (≈147 full-size)', () => {
    const l = new BudgetLedger()
    let n = 0
    for (let i = 0; i < 300; i++) {
      const r = l.reserveGroq({ conversationId: 'c', turnKey: `t${i}`, inputTokens: 10_000, now: T0 + i * 11_000 })
      if (!r.ok) {
        expect(r.reason).toBe('groq_daily_tokens')
        break
      }
      l.commitGroq(r.id)
      n++
    }
    expect(n).toBe(Math.floor(LIMITS.groq.dailyTokens / (LIMITS.groq.maxInputTokens + LIMITS.groq.maxOutputTokens)))
    expect(n).toBe(147)
  })
  it('honours Retry-After', () => {
    const l = new BudgetLedger()
    l.noteRetryAfter(30, T0)
    expect(l.reserveGroq({ conversationId: 'c', turnKey: 't', inputTokens: 1, now: T0 + 1000 })).toMatchObject({ ok: false, reason: 'groq_retry_after' })
    expect(l.reserveGroq({ conversationId: 'c', turnKey: 't', inputTokens: 1, now: T0 + 31_000 }).ok).toBe(true)
  })
})

describe('AssemblyAI reservations', () => {
  it('TTS daily character cap and refund of pre-audio failures', () => {
    const l = new BudgetLedger()
    const a = l.reserveTts(4_000, T0)
    expect(a.ok).toBe(true)
    expect(l.reserveTts(1_500, T0)).toMatchObject({ ok: false, reason: 'tts_daily_chars' })
    if (a.ok) l.releaseTts(a.id)
    expect(l.reserveTts(1_500, T0).ok).toBe(true)
  })
  it('commit reconciles billed characters', () => {
    const l = new BudgetLedger()
    const a = l.reserveTts(100, T0)
    if (a.ok) l.commitTts(a.id, 120)
    expect(l.snapshot(T0).tts.chars).toBe(120)
  })
  it('protects the $15 reserve', () => {
    const l = new BudgetLedger()
    l.lifetimeUsd = LIMITS.assembly.totalCreditUsd - LIMITS.assembly.protectedReserveUsd - 0.0001
    expect(l.reserveTts(100, T0)).toMatchObject({ ok: false, reason: 'assembly_reserve' })
    expect(l.reserveSttMinutes(10, T0)).toMatchObject({ ok: false, reason: 'assembly_reserve' })
  })
  it('STT sessions are bounded to 20 minutes and 40/day', () => {
    const l = new BudgetLedger()
    expect(l.reserveSttMinutes(60, T0)).toEqual({ ok: true, minutes: 20 })
    expect(l.reserveSttMinutes(60, T0)).toEqual({ ok: true, minutes: 20 })
    expect(l.reserveSttMinutes(5, T0)).toMatchObject({ ok: false, reason: 'stt_daily_minutes' })
    // new day resets
    expect(l.reserveSttMinutes(5, T0 + 86_400_000)).toEqual({ ok: true, minutes: 5 })
  })
  it('$1/day ceiling binds', () => {
    const l = new BudgetLedger({ ...LIMITS, assembly: { ...LIMITS.assembly, dailyTtsChars: 1_000_000 } } as unknown as typeof LIMITS)
    expect(l.reserveTts(70_000, T0)).toMatchObject({ ok: false, reason: 'assembly_daily_usd' })
  })
})
