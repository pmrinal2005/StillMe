/**
 * Shared contracts. Every external or model-generated payload is validated
 * against these schemas on BOTH server and client. Schema validity does not
 * establish that a reply is truthful or appropriate — the user still decides.
 *
 * The Python worker mirrors the approval contract in worker/revoice_worker/approval.py.
 */
import { z } from 'zod'

/** AssemblyAI TTS languages (assemblyai-tts-1). Hindi is NOT a supported output language. */
export const OUTPUT_LANGUAGES = ['english', 'spanish', 'german', 'italian', 'portuguese', 'french'] as const
export const OutputLanguage = z.enum(OUTPUT_LANGUAGES)
export type OutputLanguage = z.infer<typeof OutputLanguage>

/** Universal-3.6 Pro streaming input languages (language steering codes). */
export const INPUT_LANGUAGES = [
  'af', 'ar', 'yue', 'ca', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'gl', 'de', 'he', 'hi', 'it', 'ja',
  'ko', 'zh', 'mr', 'no', 'nn', 'fa', 'pt', 'ro', 'ru', 'es', 'sv', 'tr', 'ur', 'vi', 'xh', 'zu',
] as const
export const InputLanguage = z.enum(INPUT_LANGUAGES)

export const STT_MODEL = 'universal-3-6-pro' as const
export const TTS_MODEL = 'assemblyai-tts-1' as const

export const Intent = z.enum(['continue', 'clarify', 'decline', 'custom'])
export type Intent = z.infer<typeof Intent>

/** Risk routing increases explicit review of AI drafts; it never censors user-authored text. */
export const RiskCategory = z.enum(['none', 'medical', 'legal', 'financial', 'consent', 'relationship'])
export type RiskCategory = z.infer<typeof RiskCategory>

/** "Turn Passport": which partner turn & transcript revision a suggestion answers. */
export const TurnRef = z.object({
  conversationId: z.string().min(1).max(64),
  generation: z.number().int().min(0), // room/session generation
  turnId: z.number().int().min(0),
  revision: z.number().int().min(0),
  transcriptHash: z.string().regex(/^[a-f0-9]{64}$/),
})
export type TurnRef = z.infer<typeof TurnRef>

export const Candidate = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(400),
  intent: Intent,
  risk: RiskCategory,
})
export type Candidate = z.infer<typeof Candidate>

export const CandidateSet = z.object({
  id: z.string().min(1).max(64),
  turn: TurnRef,
  status: z.enum(['provisional', 'final']), // drafted from a partial vs. end_of_turn transcript
  outputLanguage: OutputLanguage,
  voiceId: z.string().min(1).max(128),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  candidates: z.array(Candidate).length(3),
})
export type CandidateSet = z.infer<typeof CandidateSet>

/** What Groq must return (strict JSON schema). Server attaches ids/binding afterwards. */
export const GroqSuggestionOutput = z.object({
  candidates: z
    .array(
      z.object({
        text: z.string().min(1).max(400),
        intent: Intent,
        risk: RiskCategory,
      }),
    )
    .length(3),
})

export const ConversationTurn = z.object({
  speaker: z.enum(['partner', 'user']),
  text: z.string().max(1200),
})

export const SuggestRequest = z.object({
  turn: TurnRef,
  partnerText: z.string().min(1).max(2000),
  final: z.boolean(),
  history: z.array(ConversationTurn).max(6).default([]),
  styleCard: z.string().max(600).default(''),
  outputLanguage: OutputLanguage,
  voiceId: z.string().min(1).max(128),
  preferredIntent: z.string().max(80).optional(),
})
export type SuggestRequest = z.infer<typeof SuggestRequest>

/** Limits from AssemblyAI docs: HTTP 5,000 code points; WS Generate frame 2,000. We keep messages short. */
export const MAX_SPOKEN_CHARS = 1000

export const ApproveRequest = z.object({
  text: z.string().min(1).max(MAX_SPOKEN_CHARS),
  textHash: z.string().regex(/^[a-f0-9]{64}$/),
  conversationId: z.string().min(1).max(64),
  roomName: z.string().max(128).optional(),
  generation: z.number().int().min(0),
  voiceId: z.string().min(1).max(128),
  outputLanguage: OutputLanguage,
  /** If approving an AI candidate, the candidate set + turn it was bound to. Absent for user-typed text. */
  source: z
    .object({ candidateSetId: z.string(), candidateId: z.string(), turn: TurnRef, edited: z.boolean() })
    .optional(),
})
export type ApproveRequest = z.infer<typeof ApproveRequest>

/** A signed, single-use authorization to speak exact text. */
export const Approval = z.object({
  v: z.literal(1),
  approvalId: z.string().min(16).max(64),
  playbackAttemptId: z.string().min(16).max(64),
  sub: z.string().min(1).max(128), // authenticated user id (LiveKit identity in room mode)
  conversationId: z.string().min(1).max(64),
  roomName: z.string().max(128).nullable(),
  generation: z.number().int().min(0),
  textHash: z.string().regex(/^[a-f0-9]{64}$/),
  voiceId: z.string().min(1).max(128),
  outputLanguage: OutputLanguage,
  chars: z.number().int().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  sig: z.string().regex(/^[a-f0-9]{64}$/),
})
export type Approval = z.infer<typeof Approval>

export const SpeakRequest = z.object({ approval: Approval, text: z.string().min(1).max(MAX_SPOKEN_CHARS) })

/** LiveKit data-channel messages (topic-based). */
export const DataTopics = {
  transcript: 'revoice.transcript', // worker → owner
  control: 'revoice.control', // owner → worker (approve / stop / pause)
  status: 'revoice.status', // worker → owner (speaking / done / uncertain / error)
  presence: 'revoice.presence', // owner → partner (composing indicator, no draft content)
} as const

export const TranscriptMessage = z.object({
  type: z.literal('turn'),
  generation: z.number().int(),
  turnId: z.number().int(),
  revision: z.number().int(),
  text: z.string().max(4000),
  endOfTurn: z.boolean(),
  speechStarted: z.boolean().optional(),
})

export const ControlMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('speak'), approval: Approval, text: z.string().min(1).max(MAX_SPOKEN_CHARS) }),
  z.object({ type: z.literal('stop'), playbackAttemptId: z.string().optional() }),
  z.object({ type: z.literal('listen'), enabled: z.boolean() }),
])

export const StatusMessage = z.object({
  type: z.enum(['speaking', 'done', 'cancelled', 'uncertain', 'rejected', 'error', 'listening', 'paused']),
  playbackAttemptId: z.string().optional(),
  reason: z.string().max(200).optional(),
})

export const PresenceMessage = z.object({ type: z.literal('presence'), composing: z.boolean(), holdTurn: z.boolean().optional() })
