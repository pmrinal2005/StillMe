'use client'
/**
 * On-device storage (IndexedDB via Dexie). Works offline. Phrase boards, preferences,
 * style card, and the cloned-voice consent registry live here by default.
 * No transcripts, drafts or audio are persisted.
 */
import Dexie, { type Table } from 'dexie'
import type { ClonedVoiceProfile } from '../voices'
import { PHRASE_LIMITS, buildSeed, migrateLegacy, newId, shouldApply, type LBoard, type LPhrase, type PhraseStore, type SyncPlan } from '../phrase-sync'

/** E48: boards/phrases carry `updatedAt` + an optional `deletedAt` tombstone so they can sync two-way (see lib/phrase-sync.ts). */
export type Board = LBoard
export type Phrase = LPhrase
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
    // E48: timestamps + tombstones. Old rows (random ids, no timestamps) are re-keyed/stamped by migrateLegacy.
    this.version(3)
      .stores({ boards: 'id, order, updatedAt', phrases: 'id, boardId, order, updatedAt' })
      .upgrade(async (tx) => {
        const oldBoards = await tx.table('boards').toArray()
        const oldPhrases = await tx.table('phrases').toArray()
        const m = migrateLegacy(oldBoards, oldPhrases, Date.now())
        await tx.table('boards').clear()
        await tx.table('phrases').clear()
        await tx.table('boards').bulkPut(m.boards)
        await tx.table('phrases').bulkPut(m.phrases)
      })
  }
}

export const db = new RevoiceDB()

/** Always a real UUID: the cloud `id` columns are uuid, a non-UUID id would make a whole sync batch fail. */
const uid = newId

/** Seed the built-in boards once. Deterministic ids + updatedAt 0 → two devices' defaults are the same rows (no duplicates) and never overwrite cloud data. */
export async function ensureSeed() {
  await db.transaction('rw', db.boards, db.phrases, async () => {
    if ((await db.boards.count()) > 0) return // includes tombstones: a user who deleted every board must not get the defaults back
    const s = buildSeed()
    await db.boards.bulkAdd(s.boards)
    await db.phrases.bulkAdd(s.phrases)
  })
}

// ------------------------------------------------------------------------------------------ phrase boards (E48)
const live = <T extends { deletedAt?: number | null }>(x: T) => !x.deletedAt

export async function listBoards(): Promise<Board[]> {
  return (await db.boards.orderBy('order').toArray()).filter(live)
}
export async function listPhrases(boardId: string): Promise<Phrase[]> {
  return (await db.phrases.where('boardId').equals(boardId).sortBy('order')).filter(live)
}
export type MutationResult = { ok: true; id?: string } | { ok: false; reason: 'empty' | 'too_long' | 'cap' | 'missing' }

export async function addPhraseLocal(boardId: string, rawText: string): Promise<MutationResult> {
  const text = rawText.trim()
  if (!text) return { ok: false, reason: 'empty' }
  if (text.length > PHRASE_LIMITS.phraseText) return { ok: false, reason: 'too_long' }
  return db.transaction('rw', db.boards, db.phrases, async () => {
    const board = await db.boards.get(boardId)
    if (!board || board.deletedAt) return { ok: false as const, reason: 'missing' as const }
    const all = (await db.phrases.toArray()).filter(live)
    if (all.length >= PHRASE_LIMITS.maxPhrases) return { ok: false as const, reason: 'cap' as const }
    const order = all.filter((p) => p.boardId === boardId).reduce((m, p) => Math.max(m, p.order + 1), 0)
    const id = uid()
    await db.phrases.add({ id, boardId, text, order, uses: 0, updatedAt: Date.now(), deletedAt: null })
    return { ok: true as const, id }
  })
}
export async function removePhraseLocal(id: string) {
  const now = Date.now()
  await db.phrases.update(id, { deletedAt: now, updatedAt: now })
}
export async function addBoardLocal(rawName: string): Promise<MutationResult> {
  const name = rawName.trim()
  if (!name) return { ok: false, reason: 'empty' }
  if (name.length > PHRASE_LIMITS.boardName) return { ok: false, reason: 'too_long' }
  return db.transaction('rw', db.boards, async () => {
    const all = (await db.boards.toArray()).filter(live)
    if (all.length >= PHRASE_LIMITS.maxBoards) return { ok: false as const, reason: 'cap' as const }
    const id = uid()
    await db.boards.add({ id, name, order: all.reduce((m, b) => Math.max(m, b.order + 1), 0), updatedAt: Date.now(), deletedAt: null })
    return { ok: true as const, id }
  })
}
/** Soft-delete a board AND its phrases (so other devices learn about every deletion). */
export async function removeBoardLocal(id: string) {
  const now = Date.now()
  await db.transaction('rw', db.boards, db.phrases, async () => {
    await db.boards.update(id, { deletedAt: now, updatedAt: now })
    const ps = await db.phrases.where('boardId').equals(id).toArray()
    for (const p of ps) if (!p.deletedAt) await db.phrases.update(p.id, { deletedAt: now, updatedAt: now })
  })
}
export async function setPhraseCacheable(id: string, cacheable: boolean) {
  await db.phrases.update(id, { cacheable, updatedAt: Date.now() })
}
/** A use is a counter, not an edit: it must NOT bump updatedAt (it would win every conflict against a real edit). */
export async function bumpPhraseUse(id: string) {
  await db.phrases.where('id').equals(id).modify((p) => { p.uses = (p.uses ?? 0) + 1 })
}

/** Dexie-backed store for runPhraseSync. Each merged row is written only if the local row was not edited since it was read. */
export const dexiePhraseStore: PhraseStore = {
  async readAll() {
    const [boards, phrases] = await Promise.all([db.boards.toArray(), db.phrases.toArray()])
    return { boards, phrases }
  },
  async apply(plan: Pick<SyncPlan, 'localBoards' | 'localPhrases' | 'dropLocalPhraseIds'>) {
    let n = 0
    await db.transaction('rw', db.boards, db.phrases, async () => {
      for (const { row, expect } of plan.localBoards) {
        if (!shouldApply(await db.boards.get(row.id), expect)) continue
        await db.boards.put(row)
        n++
      }
      for (const { row, expect } of plan.localPhrases) {
        if (!shouldApply(await db.phrases.get(row.id), expect)) continue
        await db.phrases.put(row)
        n++
      }
      if (plan.dropLocalPhraseIds.length) await db.phrases.bulkDelete(plan.dropLocalPhraseIds)
    })
    return n
  },
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
    boards: boards.filter(live), phrases: phrases.filter(live), voices, feedback, prefs, consentLog,
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

/**
 * B11: the SERVER registry is the source of truth for cloned voices. The device copy is only a display cache:
 * replace it with what the server returned (so a revoke/expiry/other-device change always wins, and a record that
 * only ever existed in this browser — the old self-attested kind — disappears).
 */
export async function syncVoicesFromServer(voices: ClonedVoiceProfile[]) {
  const keep = new Set(voices.map((v) => v.id))
  await db.transaction('rw', db.voices, async () => {
    for (const v of await db.voices.toArray()) if (!keep.has(v.id)) await db.voices.delete(v.id)
    for (const v of voices) await db.voices.put(v)
  })
}
