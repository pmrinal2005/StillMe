/**
 * Feature flags. Everything that could spend money or act without the user is OFF by default.
 * Add-ons stay disabled until exact pricing and compatibility are verified for the actual account.
 * Shared by the web app; the Python worker mirrors these in worker/revoice_worker/config.py.
 */
export const ADDONS = {
  /** AssemblyAI LLM Gateway — disabled while Groq is the required text provider. Not configurable. */
  llmGateway: false,
  streamingDiarization: false,
  medicalMode: false,
  guardrails: false,
  speechUnderstanding: false,
  syncSttCatchUp: false,
  dictationApi: false,
  ttsWordBoundaries: false,
  /** LiveKit enhanced noise cancellation — entitlement must be checked first. */
  enhancedNoiseCancellation: false,
  /** Speculative/preemptive TTS — must never be enabled in ReVOICE. Not configurable. */
  speculativeTts: false,
  /** Autonomous replies — must never be enabled in ReVOICE. Not configurable. */
  autonomousReplies: false,
} as const

export const TELEPHONY = {
  /** Included US local number only; activated by the owner only if no new spending is required. */
  inboundEnvFlag: 'REVOICE_PHONE_INBOUND_ENABLED',
  monthlyInboundMinutesCap: 40, // of the 50 included; 10 minutes headroom
  maxCallMinutes: 15,
  /** Never available in this prototype. */
  outboundPstn: false,
  paidCarriers: false,
  emergencyCalling: false,
} as const

export type AddonName = keyof typeof ADDONS

/** Hard invariants checked by tests and at server start. */
export function assertSafeDefaults() {
  if (ADDONS.llmGateway) throw new Error('LLM Gateway must remain disabled while Groq is the text provider')
  if (ADDONS.speculativeTts) throw new Error('Speculative TTS must remain disabled')
  if (ADDONS.autonomousReplies) throw new Error('Autonomous replies must remain disabled')
  if (TELEPHONY.outboundPstn || TELEPHONY.paidCarriers || TELEPHONY.emergencyCalling) {
    throw new Error('Outbound PSTN, paid carriers and emergency calling must remain disabled')
  }
}
