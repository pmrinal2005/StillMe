import { describe, expect, it } from 'vitest'
import {
  AutoTurnController,
  DEFAULT_AUTO_TURN,
  FINAL_GRACE_MS,
  MAX_AUTO_CHARS,
  POST_SPEECH_QUIET_MS,
  SILENCE_MAX_MS,
  SILENCE_MIN_MS,
  SilenceTurnDetector,
  VETO_MAX_MS,
  VETO_MIN_MS,
  candidateProblem,
  clampSilenceMs,
  clampVetoMs,
  intentOrder,
  isCommitmentText,
  isHighStakesText,
  liveGuard,
  normalizeAutoTurnConfig,
  partnerAsked,
  pickCandidate,
  type LiveCtx,
} from '@/lib/turn-taking'
import type { Candidate } from '@/lib/contracts'

const cand = (id: string, intent: Candidate['intent'], text: string, risk: Candidate['risk'] = 'none'): Candidate => ({ id, intent, text, risk })
const SET = {
  id: 'set1',
  candidates: [cand('a', 'continue', 'Tell me more about that.'), cand('b', 'clarify', 'Which day did you mean?'), cand('c', 'decline', 'Not today, thanks.')],
}
const CTX: LiveCtx = { composerText: '', engaged: false, outputBusy: false, online: true, fresh: true }
const PARTNER = 'We could go to the market this weekend if the weather is nice.'

describe('config bounds', () => {
  it('silence is clamped to 1.5–3.0 s and defaults to 2 s', () => {
    expect(clampSilenceMs(100)).toBe(SILENCE_MIN_MS)
    expect(clampSilenceMs(99_999)).toBe(SILENCE_MAX_MS)
    expect(clampSilenceMs(undefined)).toBe(2000)
    expect(clampSilenceMs('abc')).toBe(2000)
    expect(clampSilenceMs(2500)).toBe(2500)
  })
  it('veto window is clamped to 2–10 s', () => {
    expect(clampVetoMs(0)).toBe(VETO_MIN_MS)
    expect(clampVetoMs(1e9)).toBe(VETO_MAX_MS)
    expect(clampVetoMs(undefined)).toBe(4000)
  })
  it('auto turn-taking is OFF by default and normalisation never turns it on implicitly', () => {
    expect(DEFAULT_AUTO_TURN.enabled).toBe(false)
    expect(normalizeAutoTurnConfig(undefined).enabled).toBe(false)
    expect(normalizeAutoTurnConfig({ enabled: 'true' as unknown as boolean }).enabled).toBe(false)
    expect(normalizeAutoTurnConfig({ intent: 'bogus' as never }).intent).toBe('auto')
    expect(normalizeAutoTurnConfig({ maxConsecutive: 999 }).maxConsecutive).toBe(10)
  })
})

describe('text heuristics', () => {
  it('flags high-stakes subjects', () => {
    for (const t of ['Did you take your medication?', 'I need you to sign here', 'Can you pay $200 for it?', 'Call an ambulance', 'Do you consent to the surgery', 'what is your password']) expect(isHighStakesText(t), t).toBe(true)
    for (const t of ['The weather is lovely today', 'Shall we have pasta for dinner?']) expect(isHighStakesText(t), t).toBe(false)
  })
  it('flags affirmative commitments', () => {
    for (const t of ['Yes, sure.', "I'll be there", 'Sounds good', 'Of course!']) expect(isCommitmentText(t), t).toBe(true)
    for (const t of ['Which day did you mean?', 'Tell me more about that.', 'Not today, thanks.']) expect(isCommitmentText(t), t).toBe(false)
  })
  it('detects questions', () => {
    expect(partnerAsked('Are you coming?')).toBe(true)
    expect(partnerAsked('Do you want tea')).toBe(true)
    expect(partnerAsked('It is sunny today.')).toBe(false)
    expect(partnerAsked('')).toBe(false)
  })
})

describe('SilenceTurnDetector', () => {
  it('fires once, after the configured silence, on a FINAL substantive turn', () => {
    const d = new SilenceTurnDetector(2000)
    d.turnUpdate({ turnId: 1, text: PARTNER, endOfTurn: false }, 0)
    expect(d.tick(1900)).toBeNull()
    // the final arrives later but with the same words: the silence clock is NOT restarted
    d.turnUpdate({ turnId: 1, text: PARTNER, endOfTurn: true }, 1000)
    expect(d.tick(1999)).toBeNull()
    const ev = d.tick(2000)
    expect(ev).toMatchObject({ type: 'silence', turnId: 1, text: PARTNER })
    expect(d.tick(9999)).toBeNull() // never twice for the same words
  })
  it('a punctuation-only final does not restart the clock', () => {
    const d = new SilenceTurnDetector(1500)
    d.turnUpdate({ turnId: 1, text: 'we could go to the market', endOfTurn: false }, 0)
    d.turnUpdate({ turnId: 1, text: 'We could go to the market.', endOfTurn: true }, 1400)
    expect(d.tick(1500)?.type).toBe('silence')
  })
  it('voice activity keeps resetting the clock', () => {
    const d = new SilenceTurnDetector(1500)
    d.turnUpdate({ turnId: 1, text: PARTNER, endOfTurn: true }, 0)
    d.activity(1000)
    expect(d.tick(2000)).toBeNull()
    d.activity(2400)
    expect(d.tick(3800)).toBeNull()
    expect(d.tick(3900)?.type).toBe('silence')
  })
  it('a new word revision resets the clock', () => {
    const d = new SilenceTurnDetector(1500)
    d.turnUpdate({ turnId: 1, text: 'we could go to the market', endOfTurn: false }, 0)
    d.turnUpdate({ turnId: 1, text: 'we could go to the market this weekend', endOfTurn: true }, 1000)
    expect(d.tick(2000)).toBeNull()
    expect(d.tick(2500)?.type).toBe('silence')
  })
  it('ignores back-channels and tiny fragments', () => {
    const d = new SilenceTurnDetector(1500)
    d.turnUpdate({ turnId: 1, text: 'uh huh', endOfTurn: true }, 0)
    expect(d.tick(5000)).toBeNull()
    expect(d.pending).toBe(false)
  })
  it('gives up on a turn that never receives a final', () => {
    const d = new SilenceTurnDetector(1500)
    d.turnUpdate({ turnId: 3, text: PARTNER, endOfTurn: false }, 0)
    expect(d.tick(1500)).toBeNull()
    expect(d.tick(1500 + FINAL_GRACE_MS)).toEqual({ type: 'no_final', turnId: 3 })
    expect(d.tick(20_000)).toBeNull()
  })
  it('is deaf while our own voice is playing and for a quiet tail afterwards', () => {
    const d = new SilenceTurnDetector(1500)
    d.setBusy(true, 0)
    d.turnUpdate({ turnId: 1, text: PARTNER, endOfTurn: true }, 100)
    d.activity(200)
    expect(d.tick(10_000)).toBeNull()
    d.setBusy(false, 10_000)
    d.turnUpdate({ turnId: 2, text: PARTNER, endOfTurn: true }, 10_000 + POST_SPEECH_QUIET_MS - 1)
    expect(d.tick(20_000)).toBeNull() // still in the tail: transcript of our own echo is ignored
    d.turnUpdate({ turnId: 3, text: 'What would you like for dinner tonight?', endOfTurn: true }, 10_000 + POST_SPEECH_QUIET_MS + 1)
    expect(d.tick(10_000 + POST_SPEECH_QUIET_MS + 1 + 1500)?.type).toBe('silence')
  })
  it('exposes a 0..1 progress meter', () => {
    const d = new SilenceTurnDetector(2000)
    expect(d.progress(0)).toBe(0)
    d.turnUpdate({ turnId: 1, text: PARTNER, endOfTurn: false }, 0)
    expect(d.progress(1000)).toBeCloseTo(0.5)
    expect(d.progress(9999)).toBe(1)
  })
  it('the configured value is clamped on set', () => {
    const d = new SilenceTurnDetector(10)
    expect(d.silenceMs).toBe(SILENCE_MIN_MS)
    d.setSilenceMs(1e6)
    expect(d.silenceMs).toBe(SILENCE_MAX_MS)
  })
})

describe('pickCandidate', () => {
  it('statement → neutral continuation; question → clarification', () => {
    expect(intentOrder('auto', 'It is sunny.')[0]).toBe('continue')
    expect(intentOrder('auto', 'Are you free?')[0]).toBe('clarify')
    const r1 = pickCandidate(SET, { intent: 'auto', partnerText: 'It is sunny today and warm.' })
    expect(r1.ok && r1.candidate.id).toBe('a')
    const r2 = pickCandidate(SET, { intent: 'auto', partnerText: 'Are you free on Sunday?' })
    expect(r2.ok && r2.candidate.id).toBe('b')
  })
  it('honours an explicit intent preference', () => {
    const r = pickCandidate(SET, { intent: 'decline', partnerText: 'Would you like to come along?' })
    expect(r.ok && r.candidate.id).toBe('c')
  })
  it('never agrees on the owner behalf — skips a committing candidate for the next safe intent', () => {
    const set = { id: 's', candidates: [cand('a', 'continue', 'Yes, I will be there.'), cand('b', 'clarify', 'What time?'), cand('c', 'decline', 'No thanks.')] }
    const r = pickCandidate(set, { intent: 'auto', partnerText: 'It is sunny today and warm.' })
    expect(r.ok && r.candidate.id).toBe('b')
  })
  it('refuses when every candidate is unsafe', () => {
    const set = { id: 's', candidates: [cand('a', 'continue', 'Sure, sounds good.'), cand('b', 'clarify', 'Of course!'), cand('c', 'decline', 'Absolutely.')] }
    const r = pickCandidate(set, { intent: 'auto', partnerText: 'It is sunny today and warm.' })
    expect(r.ok).toBe(false)
  })
  it('refuses any candidate with a non-none risk category', () => {
    const set = { id: 's', candidates: [cand('a', 'continue', 'Tell me more.', 'medical'), cand('b', 'clarify', 'What do you mean?', 'consent'), cand('c', 'decline', 'Not now.', 'legal')] }
    const r = pickCandidate(set, { intent: 'auto', partnerText: 'It is sunny today and warm.' })
    expect(r).toMatchObject({ ok: false, reason: 'risk_category' })
  })
  it('refuses when the PARTNER raised a high-stakes subject, whatever the candidates say', () => {
    const r = pickCandidate(SET, { intent: 'auto', partnerText: 'Did you take your medication this morning?' })
    expect(r).toMatchObject({ ok: false, reason: 'high_stakes_partner' })
  })
  it('refuses over-long and high-stakes candidate text', () => {
    expect(candidateProblem(cand('x', 'continue', 'a'.repeat(MAX_AUTO_CHARS + 1)), 'auto')?.reason).toBe('too_long')
    expect(candidateProblem(cand('x', 'continue', 'Please transfer the money.'), 'auto')?.reason).toBe('high_stakes_candidate')
    expect(candidateProblem(cand('x', 'continue', '   '), 'auto')?.reason).toBe('empty')
  })
  it('allows "No thanks" when the owner chose the decline preference', () => {
    expect(candidateProblem(cand('x', 'decline', 'No, thanks.'), 'decline')).toBeNull()
  })
})

describe('liveGuard', () => {
  it('passes only when quiet, online, idle and fresh', () => {
    expect(liveGuard(CTX).ok).toBe(true)
    expect(liveGuard({ ...CTX, composerText: 'hel' })).toMatchObject({ ok: false, reason: 'user_typing' })
    expect(liveGuard({ ...CTX, engaged: true })).toMatchObject({ ok: false, reason: 'user_engaged' })
    expect(liveGuard({ ...CTX, outputBusy: true })).toMatchObject({ ok: false, reason: 'output_busy' })
    expect(liveGuard({ ...CTX, online: false })).toMatchObject({ ok: false, reason: 'offline' })
    expect(liveGuard({ ...CTX, fresh: false })).toMatchObject({ ok: false, reason: 'stale' })
  })
})

// ---------------------------------------------------------------------------------------------- controller
function ctl(over = {}) {
  return new AutoTurnController({ enabled: true, silenceMs: 1500, vetoMs: 3000, intent: 'auto', ...over })
}
/** Drive a controller to the 'drafting' phase for PARTNER, returning the action. */
function toDrafting(c: AutoTurnController, t0 = 0) {
  c.partnerTurn({ turnId: 1, text: PARTNER, endOfTurn: true }, t0)
  expect(c.tick(t0 + 1000, CTX)).toBeNull()
  const a = c.tick(t0 + 1500, CTX)
  expect(a).toMatchObject({ type: 'draft', turnId: 1 })
  return a
}

describe('AutoTurnController', () => {
  it('does nothing while off', () => {
    const c = new AutoTurnController()
    c.partnerTurn({ turnId: 1, text: PARTNER, endOfTurn: true }, 0)
    expect(c.tick(60_000, CTX)).toBeNull()
    expect(c.phase).toBe('off')
  })

  it('full path: silence → draft → countdown → speak (without any human action)', () => {
    const c = ctl()
    toDrafting(c)
    expect(c.phase).toBe('drafting')
    expect(c.draftReady({ set: SET, turnId: 1, partnerText: PARTNER }, 1600).ok).toBe(true)
    expect(c.phase).toBe('countdown')
    const snap = c.snapshot(2600)
    expect(snap.pick?.text).toBe('Tell me more about that.')
    expect(snap.vetoRemainingMs).toBe(2000)
    expect(c.tick(4000, CTX)).toBeNull() // veto window still open
    const act = c.tick(4600, CTX)
    expect(act).toMatchObject({ type: 'speak', viaSayIt: false, pick: { text: 'Tell me more about that.', candidateId: 'a', setId: 'set1' } })
    expect(c.phase).toBe('speaking')
  })

  it('NEVER speaks before the veto window has fully elapsed', () => {
    const c = ctl({ vetoMs: 4000 })
    toDrafting(c)
    c.draftReady({ set: SET, turnId: 1, partnerText: PARTNER }, 1600)
    for (let t = 1700; t < 5600; t += 100) expect(c.tick(t, CTX), `t=${t}`).toBeNull()
    expect(c.tick(5600, CTX)?.type).toBe('speak')
  })

  it('Cancel stops it and hands back the draft; nothing is spoken afterwards', () => {
    const c = ctl()
    toDrafting(c)
    c.draftReady({ set: SET, turnId: 1, partnerText: PARTNER }, 1600)
    const p = c.cancel('user_cancel', 2000)
    expect(p?.text).toBe('Tell me more about that.')
    expect(c.phase).toBe('idle')
    expect(c.snapshot(2100).notice?.kind).toBe('cancelled')
    expect(c.tick(60_000, CTX)).toBeNull()
  })

  it('Say it skips the wait but returns an action the app must still get approved by the server', () => {
    const c = ctl()
    toDrafting(c)
    c.draftReady({ set: SET, turnId: 1, partnerText: PARTNER }, 1600)
    const a = c.sayNow()
    expect(a).toMatchObject({ type: 'speak', viaSayIt: true })
    expect(c.phase).toBe('speaking')
    expect(c.sayNow()).toBeNull()
  })

  it('partner speaking again during the countdown drops the draft (Conversation Brake)', () => {
    const c = ctl()
    toDrafting(c)
    c.draftReady({ set: SET, turnId: 1, partnerText: PARTNER }, 1600)
    c.partnerActivity(2000)
    expect(c.phase).toBe('listening')
    expect(c.snapshot(2000).pick).toBeNull()
    expect(c.snapshot(2000).notice?.reason).toBe('partner_resumed')
    expect(c.tick(60_000, CTX)).toBeNull() // bare noise never re-drafts identical words
    // …but if they really continued, the changed words fire again after the next silence
    c.partnerTurn({ turnId: 1, text: PARTNER + ' And maybe the park afterwards.', endOfTurn: true }, 61_000)
    expect(c.tick(62_500, CTX)?.type).toBe('draft')
  })

  it('a transcript that changes under the draft drops it too', () => {
    const c = ctl()
    toDrafting(c)
    c.partnerTurn({ turnId: 1, text: PARTNER + ' Actually, never mind that.', endOfTurn: false }, 1700)
    expect(c.phase).toBe('listening')
    expect(c.draftReady({ set: SET, turnId: 1, partnerText: PARTNER }, 1800)).toMatchObject({ ok: false })
  })

  it('typing during the countdown cancels it', () => {
    const c = ctl()
    toDrafting(c)
    c.draftReady({ set: SET, turnId: 1, partnerText: PARTNER }, 1600)
    expect(c.tick(2000, { ...CTX, composerText: 'I' })).toBeNull()
    expect(c.phase).toBe('idle')
    expect(c.snapshot(2000).notice?.reason).toBe('user_typing')
  })

  it('touching the suggestion cards, going offline or a stale set cancels the countdown', () => {
    for (const [over, reason] of [[{ engaged: true }, 'user_engaged'], [{ online: false }, 'offline'], [{ fresh: false }, 'stale'], [{ outputBusy: true }, 'output_busy']] as const) {
      const c = ctl()
      toDrafting(c)
      c.draftReady({ set: SET, turnId: 1, partnerText: PARTNER }, 1600)
      expect(c.tick(2000, { ...CTX, ...over })).toBeNull()
      expect(c.snapshot(2000).notice?.reason, reason).toBe(reason)
      expect(c.phase).toBe('idle')
    }
  })

  it('does not even draft when the owner is typing or the partner raised something high-stakes', () => {
    const c = ctl()
    c.partnerTurn({ turnId: 1, text: PARTNER, endOfTurn: true }, 0)
    expect(c.tick(1500, { ...CTX, composerText: 'hello' })).toBeNull()
    expect(c.snapshot(1500).notice?.reason).toBe('user_typing')
    const d = ctl()
    d.partnerTurn({ turnId: 2, text: 'Have you taken your medication this morning?', endOfTurn: true }, 0)
    expect(d.tick(1500, CTX)).toBeNull()
    expect(d.snapshot(1500).notice?.reason).toBe('high_stakes_partner')
  })

  it('a draft with no safe candidate is dropped with an explanation', () => {
    const c = ctl()
    toDrafting(c)
    const r = c.draftReady({ set: { id: 's', candidates: [cand('a', 'continue', 'Sure!'), cand('b', 'clarify', 'Yes.'), cand('c', 'decline', 'Of course.')] }, turnId: 1, partnerText: PARTNER }, 1600)
    expect(r.ok).toBe(false)
    expect(c.phase).toBe('idle')
    expect(c.snapshot(1600).notice?.kind).toBe('blocked')
  })

  it('draftReady for another turn is ignored; a failed draft returns to idle', () => {
    const c = ctl()
    toDrafting(c)
    expect(c.draftReady({ set: SET, turnId: 99, partnerText: PARTNER }, 1600)).toMatchObject({ ok: false })
    c.draftFailed('groq_rpm', 'Suggestions are busy.', 1700)
    expect(c.phase).toBe('idle')
    expect(c.snapshot(1700).notice?.message).toBe('Suggestions are busy.')
  })

  it('dead-man switch: stops after N consecutive automatic replies until the human interacts', () => {
    const c = ctl({ maxConsecutive: 2 })
    let t = 0
    const round = (turnId: number) => {
      c.partnerTurn({ turnId, text: `Tell me about your plans for the weekend number ${turnId}.`, endOfTurn: true }, t)
      t += 1500
      const a = c.tick(t, CTX)
      if (a?.type !== 'draft') return a
      c.draftReady({ set: SET, turnId, partnerText: a.text }, t)
      t += 3000
      const s = c.tick(t, CTX)
      expect(s?.type).toBe('speak')
      c.tick(t, { ...CTX, outputBusy: true })
      t += 500
      c.tick(t, CTX) // leaves 'speaking'
      t += POST_SPEECH_QUIET_MS + 100
      return s
    }
    expect(round(1)?.type).toBe('speak')
    expect(round(2)?.type).toBe('speak')
    expect(c.snapshot(t).consecutive).toBe(2)
    expect(round(3)).toBeNull() // blocked
    expect(c.snapshot(t).notice?.reason).toBe('consecutive_limit')
    c.userInteracted()
    expect(c.snapshot(t).consecutive).toBe(0)
    expect(round(4)?.type).toBe('speak')
  })

  it('a rejected/failed speak does not count and leaves a notice', () => {
    const c = ctl()
    toDrafting(c)
    c.draftReady({ set: SET, turnId: 1, partnerText: PARTNER }, 1600)
    expect(c.tick(4600, CTX)?.type).toBe('speak')
    c.speakResult('rejected', 4700)
    expect(c.phase).toBe('idle')
    expect(c.snapshot(4700).consecutive).toBe(0) // counted when it started, refunded because nothing was spoken
    expect(c.snapshot(4700).notice?.reason).toBe('speak_rejected')
  })

  it('a result that arrives AFTER playback (any phase) still refunds a failure, and Stop resets the counter', () => {
    const c = ctl()
    toDrafting(c)
    c.draftReady({ set: SET, turnId: 1, partnerText: PARTNER }, 1600)
    expect(c.tick(4600, CTX)?.type).toBe('speak')
    expect(c.snapshot(4600).consecutive).toBe(1)
    c.tick(4700, { ...CTX, outputBusy: true })
    c.tick(6000, CTX) // playback over → idle
    expect(c.phase).toBe('idle')
    c.speakResult('stopped', 6100)
    expect(c.snapshot(6100).consecutive).toBe(0)
    expect(c.phase).toBe('idle')
  })

  it('Say it is a human decision: it never counts toward the dead-man limit', () => {
    const c = ctl()
    toDrafting(c)
    c.draftReady({ set: SET, turnId: 1, partnerText: PARTNER }, 1600)
    expect(c.sayNow()?.type).toBe('speak')
    expect(c.snapshot(1700).consecutive).toBe(0)
  })

  it('stays deaf to its own voice: partner transcript during speaking is ignored', () => {
    const c = ctl()
    toDrafting(c)
    c.draftReady({ set: SET, turnId: 1, partnerText: PARTNER }, 1600)
    expect(c.tick(4600, CTX)?.type).toBe('speak')
    c.speakResult('pending', 4600)
    c.partnerTurn({ turnId: 2, text: 'Tell me more about that.', endOfTurn: true }, 4800) // our own echo
    c.partnerActivity(4900)
    expect(c.tick(4900, { ...CTX, outputBusy: true })).toBeNull()
    expect(c.tick(9000, { ...CTX, outputBusy: false })).toBeNull() // leaves speaking, quiet tail
    expect(c.phase).toBe('idle')
    expect(c.tick(60_000, CTX)).toBeNull() // the echo never produced a draft
  })

  it('turning it off mid-countdown cancels everything', () => {
    const c = ctl()
    toDrafting(c)
    c.draftReady({ set: SET, turnId: 1, partnerText: PARTNER }, 1600)
    c.setConfig({ enabled: false })
    expect(c.phase).toBe('off')
    expect(c.tick(60_000, CTX)).toBeNull()
    expect(c.snapshot(0).pick).toBeNull()
  })

  it('reset() (new session) drops any pending draft', () => {
    const c = ctl()
    toDrafting(c)
    c.reset()
    expect(c.phase).toBe('idle')
    expect(c.draftReady({ set: SET, turnId: 1, partnerText: PARTNER }, 1600)).toMatchObject({ ok: false })
  })

  it('applies a changed silence setting live, within bounds', () => {
    const c = ctl({ silenceMs: 1500 })
    c.setConfig({ silenceMs: 99_999 })
    expect(c.config.silenceMs).toBe(SILENCE_MAX_MS)
    c.partnerTurn({ turnId: 1, text: PARTNER, endOfTurn: true }, 0)
    expect(c.tick(2999, CTX)).toBeNull()
    expect(c.tick(3000, CTX)?.type).toBe('draft')
  })
})

describe('AutoTurnController.dismissNotice', () => {
  it('hides the notice (even the consecutive-limit one) and restarts the dead-man counter', () => {
    const c = ctl({ maxConsecutive: 1 })
    toDrafting(c)
    c.draftReady({ set: SET, turnId: 1, partnerText: PARTNER }, 1600)
    expect(c.tick(4600, CTX)?.type).toBe('speak')
    c.tick(4700, { ...CTX, outputBusy: true })
    c.tick(6000, CTX)
    c.partnerTurn({ turnId: 2, text: 'Tell me what you did this morning, please.', endOfTurn: true }, 9000)
    expect(c.tick(10_600, CTX)).toBeNull()
    expect(c.snapshot(10_600).notice?.reason).toBe('consecutive_limit')
    c.dismissNotice()
    expect(c.snapshot(10_600).notice).toBeNull()
    expect(c.snapshot(10_600).consecutive).toBe(0)
  })
})

describe('shared server/client auto-speak policy', () => {
  it('TURN_TAKING bounds mirror the controller limits and only continue/clarify are auto-speakable', async () => {
    const m = await import('@/lib/turn-taking')
    expect(m.TURN_TAKING.silenceMs).toEqual({ min: m.SILENCE_MIN_MS, max: m.SILENCE_MAX_MS })
    expect(m.TURN_TAKING.vetoMs).toEqual({ min: m.VETO_MIN_MS, max: m.VETO_MAX_MS })
    expect([...m.TURN_TAKING.allowedIntents]).toEqual(['continue', 'clarify'])
  })
  it('isAutoSpeakable refuses links, e-mail, commitments, high-stakes words, money, risk and over-long text', async () => {
    const { isAutoSpeakable } = await import('@/lib/turn-taking')
    expect(isAutoSpeakable({ text: 'Tell me more about that.', risk: 'none' })).toBe(true)
    for (const text of ['See www.example.com', 'Read https://example.com/x', 'Try example.com tonight', 'Write to me@example.org', 'Yes, I agree.', 'I will pay you.', 'Is it the doctor again?', 'It costs $5.', 'Is it 20 dollars?', 'x'.repeat(300)]) {
      expect(isAutoSpeakable({ text, risk: 'none' }), text).toBe(false)
    }
    expect(isAutoSpeakable({ text: 'Tell me more.', risk: 'medical' })).toBe(false)
  })
  it('TODO1: numbers and dates are auto-speakable (only links are blocked)', async () => {
    const { isAutoSpeakable } = await import('@/lib/turn-taking')
    for (const text of ['What happens at 5 pm?', 'Tell me more about March 3rd.', 'Which room is it, 12 or 14?', 'Is the meeting on 03/04/2027?', 'Can you say that again, the 7:30 one?', 'Tell me about the 2026 plan.']) {
      expect(isAutoSpeakable({ text, risk: 'none' }), text).toBe(true)
    }
  })
  it('the browser picker proposes a draft with a number or date, but never one with a link', () => {
    const withNumber = { candidates: [cand('a', 'continue', 'Tell me about the 5 pm plan.'), cand('b', 'clarify', 'Which plan do you mean?'), cand('c', 'decline', 'Not now.')] }
    const r1 = pickCandidate(withNumber, { intent: 'continue', partnerText: 'We should talk about the plan tomorrow.' })
    expect(r1.ok && r1.candidate.id).toBe('a')
    const withLink = { candidates: [cand('a', 'continue', 'Tell me more at www.plan.example.'), cand('b', 'clarify', 'Which plan do you mean?'), cand('c', 'decline', 'Not now.')] }
    const r2 = pickCandidate(withLink, { intent: 'continue', partnerText: 'We should talk about the plan tomorrow.' })
    expect(r2.ok && r2.candidate.id).toBe('b')
  })
})
