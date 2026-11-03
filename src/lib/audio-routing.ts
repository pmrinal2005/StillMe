/**
 * B6 — Where approved synthetic speech (and partner audio) may be played.
 *
 * Architecture rule 5: the worker never treats its own synthesized output as partner input.
 *
 * Previously, in partner-link mode the owner's device AND the partner's phone both played the
 * worker's synthetic voice. The two devices sit at the same table, so the partner's microphone
 * picked up the owner's loudspeaker (browser echo cancellation only cancels a device's OWN
 * output), and ReVOICE's speech was transcribed as partner input.
 *
 * Policy (owner device):
 *   tabletop      — agent voice: YES (this device is the speaker); partner audio: n/a
 *   partner-link  — agent voice: NO  (plays only on the partner's phone, whose AEC cancels it)
 *                   partner audio: NO (co-located; would feed back)
 *   remote        — agent voice: YES (owner monitors their own voice; owner publishes no mic)
 *                   partner audio: YES (it is a call)
 * Partner device (join page): agent voice YES in every mode; never the owner's audio.
 *
 * Defence in depth: the worker additionally gates partner STT while it is speaking (all modes),
 * and while the owner's device plays fallback HTTP-TTS audio (see `gate` control message).
 */
export type ConversationMode = 'tabletop' | 'partner-link' | 'remote'
export type AudioSourceKind = 'agent' | 'partner'

export function ownerPlaysLocally(mode: ConversationMode, from: AudioSourceKind): boolean {
  if (from === 'agent') return mode !== 'partner-link'
  return mode === 'remote'
}

export function partnerPlaysLocally(from: AudioSourceKind | 'owner'): boolean {
  return from === 'agent'
}

/**
 * When speech is NOT published through the worker (B5 HTTP-TTS fallback), it plays on the owner's
 * device. Whenever a worker is still transcribing a microphone, it must be told to gate partner STT
 * for the duration, otherwise the fallback audio would be transcribed as partner input. This applies
 * to every mode (in remote calls the far-end microphone can still leak our audio back).
 */
export const OWNER_FALLBACK_GATES_WORKER = true

/** Echo tail (ms) after our own speech ends during which partner audio is still treated as echo. */
export function echoTailMs(mode: ConversationMode): number {
  // Partner devices receive audio over the network (jitter buffer + transport), so the tail is longer.
  return mode === 'tabletop' ? 350 : 800
}

/**
 * B5 hardening: can the partner actually HEAR speech delivered by the HTTP-TTS fallback?
 * Fallback audio plays on the owner's device only. That works when the partner is co-located
 * (tabletop, partner-link) but NOT in a remote call: the far-end partner hears nothing. The UI must
 * say so instead of implying the message was delivered.
 */
export function fallbackAudibleToPartner(mode: ConversationMode): boolean {
  return mode !== 'remote'
}

/** User-facing notice when room delivery falls back to this device (reason-aware, mode-aware). */
export function fallbackNotice(mode: ConversationMode, reason: string): string {
  const why = reason === 'worker_left' ? 'The voice worker disconnected before speaking'
    : reason.startsWith('worker_bad_signature') ? 'The voice worker could not verify approvals (check REVOICE_APPROVAL_SECRET on the worker)'
      : 'The voice worker did not respond'
  return fallbackAudibleToPartner(mode)
    ? `${why}, so your approved words are being spoken from this device instead.`
    : `${why}. Your approved words are playing on THIS device only — your remote partner cannot hear them until the worker reconnects.`
}
