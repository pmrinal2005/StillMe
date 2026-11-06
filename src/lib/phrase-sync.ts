/**
 * E48: two-way phrase-board sync. PURE (no Dexie, no Supabase, no `server-only`) so the merge, the legacy migration and the
 * orchestration are unit-tested with an in-memory store and a fake remote.
 *
 * Model
 *  - every board / phrase carries `updatedAt` (ms) and an optional `deletedAt` tombstone (soft delete, so a deletion on
 *    one device can propagate; the server purges tombstones after 60 days);
 *  - last-writer-wins PER ROW on `updatedAt` (ties: the cloud copy wins — deterministic on every device);
 *  - `updatedAt === 0` means "untouched default": such a row is never pushed on its own and always loses to a cloud row,
 *    so a fresh device can never overwrite a user's cloud boards with the built-in defaults;
 *  - the built-in boards use DETERMINISTIC ids, so two devices' defaults are the same rows and never duplicate;
 *  - deleting a board tombstones its phrases; a phrase can never be pushed before its board exists in the cloud (FK);
 *  - `uses` is a counter, not an edit: it never bumps `updatedAt` and merges as max().
 */

export interface LBoard { id: string; name: string; order: number; updatedAt: number; deletedAt?: number | null }
export interface LPhrase { id: string; boardId: string; text: string; order: number; uses: number; cacheable?: boolean; updatedAt: number; deletedAt?: number | null }

/** Server limits (migration 0001 checks + 0005 caps trigger). Enforced in the UI so a batch is never rejected as a whole. */
export const PHRASE_LIMITS = { boardName: 40, phraseText: 400, maxBoards: 40, maxPhrases: 600 } as const

export const SEED: Record<string, string[]> = {
  Quick: ['Yes', 'No', 'Please wait, I am typing.', 'I have something to add.', 'Thank you.', 'Could you repeat that?'],
  Needs: ['I need a break.', 'Can you help me, please?', 'I am uncomfortable.', 'I would like some water.', 'Please call my caregiver.'],
  Social: ['Hello! Nice to see you.', 'How are you doing?', 'That is funny.', 'Tell me more.', 'Goodbye, talk soon.'],
}

// ---------------------------------------------------------------------------------------------------------- ids
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s)

function fnv(str: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Deterministic, well-formed UUID (version nibble 5, RFC variant) derived from a string. Same input → same id on every device. */
export function deterministicUuid(input: string): string {
  const parts = [0x811c9dc5, 0x1b873593, 0xcc9e2d51, 0x85ebca6b].map((s) => fnv(input, s).toString(16).padStart(8, '0'))
  const hex = parts.join('')
  const v = '5' + hex.slice(13, 16)
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${v}-${variant}-${hex.slice(20, 32)}`
}

export const seedBoardId = (name: string) => deterministicUuid(`revoice:seed:board:${name}`)
export const seedPhraseId = (board: string, text: string) => deterministicUuid(`revoice:seed:phrase:${board}:${text}`)

/** Always a real UUID (the server column is `uuid`; a non-UUID id would make the whole upsert fail). */
export function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c?.randomUUID) return c.randomUUID()
  const b = new Uint8Array(16)
  if (c?.getRandomValues) c.getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** The built-in boards: deterministic ids and `updatedAt: 0` (untouched defaults — see header). */
export function buildSeed(): { boards: LBoard[]; phrases: LPhrase[] } {
  const boards: LBoard[] = []
  const phrases: LPhrase[] = []
  let bi = 0
  for (const [name, list] of Object.entries(SEED)) {
    const id = seedBoardId(name)
    boards.push({ id, name, order: bi++, updatedAt: 0, deletedAt: null })
    list.forEach((text, i) => phrases.push({ id: seedPhraseId(name, text), boardId: id, text, order: i, uses: 0, updatedAt: 0, deletedAt: null }))
  }
  return { boards, phrases }
}

// ------------------------------------------------------------------------------------------ legacy migration
/**
 * Dexie v2 → v3. Old rows had random ids and no timestamps. Rows that are still the untouched defaults (same board name +
 * same text) are re-keyed to the deterministic seed ids with `updatedAt: 0`; everything the user created gets `updatedAt: now`
 * (so it uploads on the first sync). Non-UUID ids (old Math.random fallback) are replaced so they can be uploaded.
 */
export function migrateLegacy(
  boards: Array<Partial<LBoard> & { id: string; name: string; order: number }>,
  phrases: Array<Partial<LPhrase> & { id: string; boardId: string; text: string; order: number; uses?: number }>,
  now: number,
): { boards: LBoard[]; phrases: LPhrase[] } {
  const usedBoardIds = new Set<string>()
  const boardMap = new Map<string, string>() // old id → new id
  const outBoards: LBoard[] = []
  for (const b of boards) {
    let id = b.id
    let stamp = now
    if (b.name in SEED && !usedBoardIds.has(seedBoardId(b.name))) {
      id = seedBoardId(b.name)
      stamp = 0
    } else if (!isUuid(id) || usedBoardIds.has(id)) id = newId()
    usedBoardIds.add(id)
    boardMap.set(b.id, id)
    outBoards.push({ id, name: b.name.slice(0, PHRASE_LIMITS.boardName), order: b.order, updatedAt: b.updatedAt ?? stamp, deletedAt: b.deletedAt ?? null })
  }
  const usedPhraseIds = new Set<string>()
  const outPhrases: LPhrase[] = []
  for (const p of phrases) {
    const newBoard = boardMap.get(p.boardId)
    if (!newBoard) continue // orphan
    const boardName = outBoards.find((b) => b.id === newBoard)?.name ?? ''
    const isSeedBoard = newBoard === seedBoardId(boardName)
    let id = p.id
    let stamp = now
    if (isSeedBoard && SEED[boardName]?.includes(p.text) && !p.cacheable && !usedPhraseIds.has(seedPhraseId(boardName, p.text))) {
      id = seedPhraseId(boardName, p.text)
      stamp = 0
    } else if (!isUuid(id) || usedPhraseIds.has(id)) id = newId()
    usedPhraseIds.add(id)
    outPhrases.push({
      id, boardId: newBoard, text: p.text.slice(0, PHRASE_LIMITS.phraseText), order: p.order, uses: Math.max(0, p.uses ?? 0),
      cacheable: !!p.cacheable, updatedAt: p.updatedAt ?? stamp, deletedAt: p.deletedAt ?? null,
    })
  }
  return { boards: outBoards, phrases: outPhrases }
}

// -------------------------------------------------------------------------------------------- remote mapping
export interface RemoteBoardRow { id: string; user_id: string; name: string; sort: number; updated_at: string; deleted_at: string | null }
export interface RemotePhraseRow { id: string; user_id: string; board_id: string; text: string; sort: number; cacheable: boolean; uses: number; updated_at: string; deleted_at: string | null }

const iso = (ms: number) => new Date(ms).toISOString()
export const toRemoteBoard = (b: LBoard, userId: string): RemoteBoardRow => ({
  id: b.id, user_id: userId, name: b.name.trim().slice(0, PHRASE_LIMITS.boardName), sort: Math.max(0, Math.round(b.order)),
  updated_at: iso(b.updatedAt), deleted_at: b.deletedAt ? iso(b.deletedAt) : null,
})
export const toRemotePhrase = (p: LPhrase, userId: string): RemotePhraseRow => ({
  id: p.id, user_id: userId, board_id: p.boardId, text: p.text.slice(0, PHRASE_LIMITS.phraseText), sort: Math.max(0, Math.round(p.order)),
  cacheable: !!p.cacheable, uses: Math.max(0, Math.round(p.uses)), updated_at: iso(p.updatedAt), deleted_at: p.deletedAt ? iso(p.deletedAt) : null,
})

const MAX_FUTURE_SKEW_MS = 5 * 60_000
const stamp = (v: unknown, now: number): number | null => {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  if (!Number.isFinite(t) || t < 0) return null
  return Math.min(t, now + MAX_FUTURE_SKEW_MS) // a device with a wildly fast clock must not win every future conflict
}
const int = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null)

/** The cloud row is untrusted input to the UI: validate every field, drop what does not fit. */
export function boardFromRemote(r: unknown, now: number): LBoard | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  const updatedAt = stamp(o.updated_at, now)
  const order = int(o.sort, 0, 100000)
  if (!isUuid(o.id) || typeof o.name !== 'string' || o.name.length > PHRASE_LIMITS.boardName || updatedAt === null || order === null) return null
  const deletedAt = o.deleted_at == null ? null : stamp(o.deleted_at, now)
  if (o.deleted_at != null && deletedAt === null) return null
  return { id: o.id, name: o.name, order, updatedAt, deletedAt }
}
export function phraseFromRemote(r: unknown, now: number): LPhrase | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  const updatedAt = stamp(o.updated_at, now)
  const order = int(o.sort, 0, 100000)
  const uses = int(o.uses ?? 0, 0, 1_000_000_000)
  if (!isUuid(o.id) || !isUuid(o.board_id) || typeof o.text !== 'string' || o.text.length > PHRASE_LIMITS.phraseText || updatedAt === null || order === null || uses === null) return null
  if (typeof o.cacheable !== 'boolean' && o.cacheable != null) return null
  const deletedAt = o.deleted_at == null ? null : stamp(o.deleted_at, now)
  if (o.deleted_at != null && deletedAt === null) return null
  return { id: o.id, boardId: o.board_id, text: o.text, order, uses, cacheable: !!o.cacheable, updatedAt, deletedAt }
}

// ------------------------------------------------------------------------------------------------- the merge
const sameBoard = (a: LBoard, b: LBoard) => a.name === b.name && a.order === b.order && !!a.deletedAt === !!b.deletedAt
const samePhrase = (a: LPhrase, b: LPhrase) =>
  a.text === b.text && a.order === b.order && a.boardId === b.boardId && !!a.cacheable === !!b.cacheable && !!a.deletedAt === !!b.deletedAt

export interface SyncPlan {
  /** Rows to write locally. `expect` = the local updatedAt we merged against (null = row did not exist): the write is skipped if the row changed meanwhile. */
  localBoards: Array<{ row: LBoard; expect: number | null }>
  localPhrases: Array<{ row: LPhrase; expect: number | null }>
  dropLocalPhraseIds: string[]
  remoteBoards: LBoard[]
  remotePhrases: LPhrase[]
  liveBoards: number
  livePhrases: number
  overCap: boolean
}

function lww<T extends { id: string; updatedAt: number; deletedAt?: number | null }>(
  local: T[], remote: T[], same: (a: T, b: T) => boolean, withUses?: (win: T, other: T) => T,
) {
  const L = new Map(local.map((x) => [x.id, x]))
  const R = new Map(remote.map((x) => [x.id, x]))
  const merged = new Map<string, T>()
  const adopt: Array<{ row: T; expect: number | null }> = []
  const push: T[] = []
  for (const id of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(id)
    const r = R.get(id)
    if (l && !r) {
      merged.set(id, l)
      if (l.updatedAt > 0) push.push(l) // untouched defaults are never uploaded on their own
    } else if (r && !l) {
      merged.set(id, r)
      adopt.push({ row: r, expect: null })
    } else if (l && r) {
      if (same(l, r)) {
        const m = withUses ? withUses(l, r) : l
        merged.set(id, m)
        if (m !== l) adopt.push({ row: { ...l, ...m }, expect: l.updatedAt })
      } else if (l.updatedAt > r.updatedAt) {
        merged.set(id, l)
        push.push(l)
      } else {
        const m = withUses ? withUses(r, l) : r
        merged.set(id, m)
        adopt.push({ row: m, expect: l.updatedAt })
      }
    }
  }
  return { merged, adopt, push }
}

export function planSync(localB: LBoard[], localP: LPhrase[], remoteB: LBoard[], remoteP: LPhrase[]): SyncPlan {
  const maxUses = (win: LPhrase, other: LPhrase): LPhrase => (win.uses >= other.uses ? win : { ...win, uses: other.uses })
  const boards = lww(localB, remoteB, sameBoard)
  const phrases = lww(localP, remoteP, samePhrase, maxUses)

  const remoteBoardIds = new Set(remoteB.map((b) => b.id))
  const pushPhraseMap = new Map(phrases.push.map((p) => [p.id, p]))
  const adoptPhraseMap = new Map(phrases.adopt.map((a) => [a.row.id, a]))
  const dropLocalPhraseIds: string[] = []
  const localPhraseIds = new Set(localP.map((p) => p.id))

  // Referential integrity + cascade: a phrase needs a live-or-tombstoned board; a deleted board deletes its phrases.
  for (const [id, p] of [...phrases.merged]) {
    const b = boards.merged.get(p.boardId)
    if (!b) {
      phrases.merged.delete(id)
      pushPhraseMap.delete(id)
      adoptPhraseMap.delete(id)
      if (localPhraseIds.has(id)) dropLocalPhraseIds.push(id)
      continue
    }
    if (b.deletedAt && !p.deletedAt) {
      const t: LPhrase = { ...p, deletedAt: b.deletedAt, updatedAt: Math.max(p.updatedAt, b.updatedAt) + 1 }
      phrases.merged.set(id, t)
      pushPhraseMap.set(id, t)
      adoptPhraseMap.set(id, { row: t, expect: localPhraseIds.has(id) ? (localP.find((x) => x.id === id)?.updatedAt ?? null) : null })
    }
  }

  // FK: any phrase we upload needs its board in the cloud — upload the board too if the cloud lacks it.
  const pushBoardMap = new Map(boards.push.map((b) => [b.id, b]))
  for (const p of pushPhraseMap.values()) {
    if (!remoteBoardIds.has(p.boardId) && !pushBoardMap.has(p.boardId)) {
      const b = boards.merged.get(p.boardId)
      if (b) pushBoardMap.set(b.id, b)
    }
  }

  const liveBoards = [...boards.merged.values()].filter((b) => !b.deletedAt).length
  const livePhrases = [...phrases.merged.values()].filter((p) => !p.deletedAt).length
  return {
    localBoards: boards.adopt,
    localPhrases: [...adoptPhraseMap.values()],
    dropLocalPhraseIds,
    remoteBoards: [...pushBoardMap.values()],
    remotePhrases: [...pushPhraseMap.values()],
    liveBoards,
    livePhrases,
    overCap: liveBoards > PHRASE_LIMITS.maxBoards || livePhrases > PHRASE_LIMITS.maxPhrases,
  }
}

/** Race guard used by the on-device store: only apply a merged row if the local row has not been edited since we read it. */
export function shouldApply(current: { updatedAt: number } | undefined, expect: number | null): boolean {
  if (expect === null) return current === undefined
  return !!current && current.updatedAt <= expect
}

// ------------------------------------------------------------------------------------------- orchestration
export interface PhraseStore {
  readAll(): Promise<{ boards: LBoard[]; phrases: LPhrase[] }>
  apply(plan: Pick<SyncPlan, 'localBoards' | 'localPhrases' | 'dropLocalPhraseIds'>): Promise<number>
}
export interface PhraseRemote {
  fetchBoards(): Promise<{ rows: unknown[]; error?: { code?: string; message?: string } | null }>
  fetchPhrases(): Promise<{ rows: unknown[]; error?: { code?: string; message?: string } | null }>
  upsertBoards(rows: RemoteBoardRow[]): Promise<{ code?: string; message?: string } | null>
  upsertPhrases(rows: RemotePhraseRow[]): Promise<{ code?: string; message?: string } | null>
}
export interface SyncResult { ok: boolean; pulled: number; pushed: number; message?: string; code?: string }

const chunk = <T,>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))

function friendly(code: string | undefined, message: string | undefined): string {
  if (/board_cap/.test(message ?? '')) return `You have reached the limit of ${PHRASE_LIMITS.maxBoards} boards. Delete a board to sync new ones.`
  if (/phrase_cap/.test(message ?? '')) return `You have reached the limit of ${PHRASE_LIMITS.maxPhrases} phrases. Delete some phrases to sync new ones.`
  if (code === '42P01') return 'The phrase tables are missing on the server (run the Supabase migrations).'
  if (code === '42501' || code === 'PGRST301') return 'You are not allowed to sync phrases (sign in again).'
  return `Phrases could not be synced (${code ?? 'error'}). They are kept on this device and will be retried.`
}

export async function runPhraseSync(deps: { store: PhraseStore; remote: PhraseRemote; userId: string; now?: () => number }): Promise<SyncResult> {
  const now = (deps.now ?? Date.now)()
  const [rb, rp] = await Promise.all([deps.remote.fetchBoards(), deps.remote.fetchPhrases()])
  const fetchErr = rb.error ?? rp.error
  if (fetchErr) return { ok: false, pulled: 0, pushed: 0, code: fetchErr.code, message: friendly(fetchErr.code, fetchErr.message) }

  const remoteB = rb.rows.map((r) => boardFromRemote(r, now)).filter((x): x is LBoard => !!x)
  const remoteP = rp.rows.map((r) => phraseFromRemote(r, now)).filter((x): x is LPhrase => !!x)
  const local = await deps.store.readAll()
  const plan = planSync(local.boards, local.phrases, remoteB, remoteP)

  const pulled = await deps.store.apply(plan)

  if (plan.overCap) {
    return { ok: false, pulled, pushed: 0, code: 'cap', message: `Too many phrases to sync (limit ${PHRASE_LIMITS.maxBoards} boards / ${PHRASE_LIMITS.maxPhrases} phrases). Delete some to continue syncing.` }
  }
  let pushed = 0
  for (const part of chunk(plan.remoteBoards, 100)) {
    const err = await deps.remote.upsertBoards(part.map((b) => toRemoteBoard(b, deps.userId)))
    if (err) return { ok: false, pulled, pushed, code: err.code, message: friendly(err.code, err.message) }
    pushed += part.length
  }
  for (const part of chunk(plan.remotePhrases, 100)) {
    const err = await deps.remote.upsertPhrases(part.map((p) => toRemotePhrase(p, deps.userId)))
    if (err) return { ok: false, pulled, pushed, code: err.code, message: friendly(err.code, err.message) }
    pushed += part.length
  }
  return { ok: true, pulled, pushed }
}
