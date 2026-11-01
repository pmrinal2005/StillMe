/**
 * User-OUTPUT state machine (kept separate from partner-INPUT state).
 *
 * Idle → UserReview → ApprovedPendingGap → Speaking → Idle
 * plus: Interrupted, DeliveryUncertain, PausedForBudget, Offline, Error.
 *
 * Invariants (tested in tests/output-state.test.ts):
 *  - Nothing reaches Speaking without an approval for the exact text.
 *  - A network failure after audio started → DeliveryUncertain, never auto-replay.
 *  - Stop → Interrupted; interrupted messages never resume automatically.
 *  - A held approval is cancelled if the partner's context materially changes.
 */
export type OutputState =
  | { kind: 'idle' }
  | { kind: 'review'; text: string }
  | { kind: 'approved_pending_gap'; text: string; approvalId: string; heldSince: number }
  | { kind: 'speaking'; text: string; approvalId: string; attemptId: string; audioStarted: boolean }
  | { kind: 'interrupted'; text: string }
  | { kind: 'delivery_uncertain'; text: string; reason: string }
  | { kind: 'paused_for_budget'; reason: string }
  | { kind: 'offline' }
  | { kind: 'error'; message: string; text?: string }

export type OutputEvent =
  | { type: 'edit'; text: string }
  | { type: 'approved'; text: string; approvalId: string; partnerSpeaking: boolean; now: number }
  | { type: 'gap' }
  | { type: 'speak_now' }
  | { type: 'started'; attemptId: string }
  | { type: 'first_audio' }
  | { type: 'finished' }
  | { type: 'stop' }
  | { type: 'network_failed'; reason: string }
  | { type: 'context_changed'; reason: string }
  | { type: 'budget'; reason: string }
  | { type: 'failed'; message: string }
  | { type: 'reset' }

export function reduceOutput(s: OutputState, e: OutputEvent): OutputState {
  switch (e.type) {
    case 'reset':
      return { kind: 'idle' }
    case 'edit':
      if (s.kind === 'speaking') return s // editing doesn't affect in-flight speech
      return e.text.trim() ? { kind: 'review', text: e.text } : { kind: 'idle' }
    case 'approved':
      if (s.kind === 'speaking') return s // one utterance at a time; caller must stop first
      return e.partnerSpeaking
        ? { kind: 'approved_pending_gap', text: e.text, approvalId: e.approvalId, heldSince: e.now }
        : { kind: 'speaking', text: e.text, approvalId: e.approvalId, attemptId: '', audioStarted: false }
    case 'gap':
    case 'speak_now':
      if (s.kind !== 'approved_pending_gap') return s
      return { kind: 'speaking', text: s.text, approvalId: s.approvalId, attemptId: '', audioStarted: false }
    case 'started':
      return s.kind === 'speaking' ? { ...s, attemptId: e.attemptId } : s
    case 'first_audio':
      return s.kind === 'speaking' ? { ...s, audioStarted: true } : s
    case 'finished':
      return s.kind === 'speaking' ? { kind: 'idle' } : s
    case 'stop':
      if (s.kind === 'speaking' || s.kind === 'approved_pending_gap') return { kind: 'interrupted', text: s.text }
      return s
    case 'network_failed':
      if (s.kind !== 'speaking') return s
      // Before any audio: nothing was heard → plain error (still no automatic retry).
      return s.audioStarted
        ? { kind: 'delivery_uncertain', text: s.text, reason: e.reason }
        : { kind: 'error', message: e.reason, text: s.text }
    case 'context_changed':
      // Held (not yet spoken) approvals require renewed approval after a material change.
      return s.kind === 'approved_pending_gap' ? { kind: 'review', text: s.text } : s
    case 'budget':
      return { kind: 'paused_for_budget', reason: e.reason }
    case 'failed':
      return { kind: 'error', message: e.message, text: 'text' in s ? s.text : undefined }
  }
}

/** Is the partner currently mid-turn? (partial transcript updated recently and not end_of_turn) */
export function partnerIsSpeaking(latest: { endOfTurn: boolean; updatedAt: number } | undefined, now: number, windowMs = 1800): boolean {
  if (!latest) return false
  return !latest.endOfTurn && now - latest.updatedAt < windowMs
}

export const OUTPUT_LABELS: Record<OutputState['kind'], string> = {
  idle: 'Ready',
  review: 'Reviewing',
  approved_pending_gap: 'Approved — waiting for a pause',
  speaking: 'Speaking',
  interrupted: 'Stopped',
  delivery_uncertain: 'Delivery uncertain',
  paused_for_budget: 'Paused for budget',
  offline: 'Offline',
  error: 'Error',
}
