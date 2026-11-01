'use client'
/**
 * On-device storage (IndexedDB via Dexie). Works offline. Phrase boards, preferences,
 * style card, and the cloned-voice consent registry live here by default.
 * No transcripts, drafts or audio are persisted.
 */
import Dexie, { type Table } from 'dexie'
import type { ClonedVoiceProfile } from '../voices'

export interface Board { id: string; name: string; order: number }
export interface Phrase { id: string; boardId: string; text: string; order: number; uses: number }
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
  const [boards, phrases, voices, feedback, prefs, bank] = await Promise.all([
    db.boards.toArray(), db.phrases.toArray(), db.voices.toArray(), db.feedback.toArray(), db.prefs.toArray(), db.bank.toArray(),
  ])
  return { boards, phrases, voices, feedback, prefs, bank: bank.map(({ blob: _b, ...m }) => m) }
}

export async function wipeLocal() {
  await db.delete()
}

export { uid }
