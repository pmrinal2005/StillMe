import { INPUT_LANGUAGES, OUTPUT_LANGUAGES } from './contracts'

/** Human labels. INPUT = what the partner may speak (STT). OUTPUT = what ReVOICE can speak (TTS). */
export const INPUT_LANGUAGE_LABELS: Record<(typeof INPUT_LANGUAGES)[number], string> = {
  af: 'Afrikaans', ar: 'Arabic', yue: 'Cantonese', ca: 'Catalan', da: 'Danish', nl: 'Dutch', en: 'English', et: 'Estonian',
  fi: 'Finnish', fr: 'French', gl: 'Galician', de: 'German', he: 'Hebrew', hi: 'Hindi', it: 'Italian', ja: 'Japanese',
  ko: 'Korean', zh: 'Mandarin', mr: 'Marathi', no: 'Norwegian', nn: 'Norwegian Nynorsk', fa: 'Persian', pt: 'Portuguese',
  ro: 'Romanian', ru: 'Russian', es: 'Spanish', sv: 'Swedish', tr: 'Turkish', ur: 'Urdu', vi: 'Vietnamese', xh: 'Xhosa', zu: 'Zulu',
}

export const OUTPUT_LANGUAGE_LABELS: Record<(typeof OUTPUT_LANGUAGES)[number], string> = {
  english: 'English', spanish: 'Spanish', german: 'German', italian: 'Italian', portuguese: 'Portuguese', french: 'French',
}

/** BCP-47 tags for the optional device (system) voice fallback. */
export const OUTPUT_BCP47: Record<(typeof OUTPUT_LANGUAGES)[number], string> = {
  english: 'en-US', spanish: 'es-ES', german: 'de-DE', italian: 'it-IT', portuguese: 'pt-PT', french: 'fr-FR',
}

/** Input languages without a matching spoken-output language (e.g. Hindi/Hinglish). */
export function hasNoSpokenOutput(code: string): boolean {
  const map: Record<string, string> = { en: 'english', es: 'spanish', de: 'german', it: 'italian', pt: 'portuguese', fr: 'french' }
  return !map[code]
}
