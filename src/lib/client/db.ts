'use client'
/**
 * On-device storage (IndexedDB via Dexie). Works offline. Phrase boards, preferences,
 * style card, and the cloned-voice consent registry live here by default.
 * No transcripts, drafts or audio are persisted.
 */
import Dexie, { type Table } from 'dexie'
import type { ClonedVoiceProfile } from '../voices'

export interface Board { id: string; name: string; order: number }
export interface Phrase { id: string; boardId: string; text: string; order: number; uses: number; cacheable?: boolean }
/**
 * Authorized synthesized-audio cache for reusable phrases. Only LIBRARY voices are cached:
 * cloned-voice audio is never cached, so cached clips can never be used to evade the provider's
 * 60-day biometric-consent expiry. Entries are keyed by (voiceId, language, textHash).
 */
export interface CachedAudio { key: string; voiceId: string; language: string; textHash: string; pcm: ArrayBuffer; sampleRate: number; createdAt: number }
export interface ConsentEvent { id: string; voiceRecordId: string; action: 'initial' | 'renewal' | 'revocation'; at: number }
/** Original message-bank recordings (user-authored, independently authorized). Not synthetic. */
export interface BankedMessage { id: string; label: string; transcript: string; blob: Blob; mime: string; createdAt: number }
export interface Feedback { id: string; at: number; intent: string; verdict: 'sounds_like_me' | 'not_my_meaning'; edited: boolean }
export interface Pref { key: string; value: unknown }

class RevoiceDB extends Dexie {
  boards!: Table<Board, string>
  phrases!: Table<Phrase, string>
  voices!: Table<ClonedVoiceProfile, string>
  bank!: Table<BankedMessage, string>
  feedback!: Table<Feedback, string>
  prefs!: Table<Pref, string>
  audioCache!: Table<CachedAudio, string>
  consentLog!: Table<ConsentEvent, string>
  constructor() {
    super('revoice')
    this.version(1).stores({
      boards: 'id, order',
      phrases: 'id, boardId, order',
      voices: 'id, voiceId',
      bank: 'id, createdAt',
      feedback: 'id, at',
      prefs: 'key',
    })
    this.version(2).stores({
      audioCache: 'key, voiceId, createdAt',
      consentLog: 'id, voiceRecordId, at',
    })
  }
}

export const db = new RevoiceDB()

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2))

const SEED: Record<string, string[]> = {
  Quick: ['Yes', 'No', 'Please wait, I am typing.', 'I have something to add.', 'Thank you.', 'Could you repeat that?'],
  Needs: ['I need a break.', 'Can you help me, please?', 'I am uncomfortable.', 'I would like some water.', 'Please call my caregiver.'],
  Social: ['Hello! Nice to see you.', 'How are you doing?', 'That is funny.', 'Tell me more.', 'Goodbye, talk soon.'],
}

export async function ensureSeed() {
  if ((await db.boards.count()) > 0) return
  let bi = 0
  for (const [name, phrases] of Object.entries(SEED)) {
    const id = uid()
    await db.boards.add({ id, name, order: bi++ })
    await db.phrases.bulkAdd(phrases.map((text, i) => ({ id: uid(), boardId: id, text, order: i, uses: 0 })))
  }
}

export async function getPref<T>(key: string, fallback: T): Promise<T> {
  const p = await db.prefs.get(key)
  return (p?.value as T) ?? fallback
}
export async function setPref(key: string, value: unknown) {
  await db.prefs.put({ key, value })
}

export async function exportLocal() {
  const [boards, phrases, voices, feedback, prefs, bank, consentLog, cacheCount] = await Promise.all([
    db.boards.toArray(), db.phrases.toArray(), db.voices.toArray(), db.feedback.toArray(), db.prefs.toArray(), db.bank.toArray(),
    db.consentLog.toArray(), db.audioCache.count(),
  ])
  return {
    format: 'revoice-local-export-v2',
    exportedAt: new Date().toISOString(),
    boards, phrases, voices, feedback, prefs, consentLog,
    bank: bank.map(({ blob: _b, ...m }) => m),
    note: `Message-bank audio blobs and ${cacheCount} cached phrase clip(s) are not included in this JSON export.`,
  }
}

export async function wipeLocal() {
  await db.delete()
}

export { uid }

const cacheKey = (voiceId: string, language: string, textHash: string) => `${voiceId}|${language}|${textHash}`

export async function getCachedAudio(voiceId: string, language: string, textHash: string) {
  return db.audioCache.get(cacheKey(voiceId, language, textHash))
}

export async function putCachedAudio(e: Omit<CachedAudio, 'key' | 'createdAt'>, isLibraryVoice: boolean) {
  if (!isLibraryVoice) return // never cache cloned-voice audio
  await db.audioCache.put({ ...e, key: cacheKey(e.voiceId, e.language, e.textHash), createdAt: Date.now() })
  // keep the cache small
  const n = await db.audioCache.count()
  if (n > 60) {
    const old = await db.audioCache.orderBy('createdAt').limit(n - 60).primaryKeys()
    await db.audioCache.bulkDelete(old)
  }
}

export async function purgeVoiceCache(voiceId: string) {
  await db.audioCache.where('voiceId').equals(voiceId).delete()
}
