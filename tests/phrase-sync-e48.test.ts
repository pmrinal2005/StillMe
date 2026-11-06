import { describe, expect, it } from 'vitest'
import {
  PHRASE_LIMITS, SEED, boardFromRemote, buildSeed, deterministicUuid, isUuid, migrateLegacy, newId, phraseFromRemote, planSync, runPhraseSync,
  seedBoardId, shouldApply, toRemoteBoard, toRemotePhrase,
  type LBoard, type LPhrase, type PhraseRemote, type PhraseStore, type RemoteBoardRow, type RemotePhraseRow,
} from '@/lib/phrase-sync'

const T0 = Date.parse('2026-11-06T12:00:00Z')
const USER = '11111111-1111-4111-8111-111111111111'

/** In-memory device (mirrors the Dexie store incl. the race guard). */
class Device implements PhraseStore {
  boards = new Map<string, LBoard>()
  phrases = new Map<string, LPhrase>()
  constructor(seed = true) {
    if (seed) { const s = buildSeed(); s.boards.forEach((b) => this.boards.set(b.id, b)); s.phrases.forEach((p) => this.phrases.set(p.id, p)) }
  }
  async readAll() { return { boards: [...this.boards.values()].map((b) => ({ ...b })), phrases: [...this.phrases.values()].map((p) => ({ ...p })) } }
  async apply(plan: Parameters<PhraseStore['apply']>[0]) {
    let n = 0
    for (const { row, expect: e } of plan.localBoards) if (shouldApply(this.boards.get(row.id), e)) { this.boards.set(row.id, row); n++ }
    for (const { row, expect: e } of plan.localPhrases) if (shouldApply(this.phrases.get(row.id), e)) { this.phrases.set(row.id, row); n++ }
    plan.dropLocalPhraseIds.forEach((id) => this.phrases.delete(id))
    return n
  }
  liveBoards() { return [...this.boards.values()].filter((b) => !b.deletedAt).sort((a, b) => a.order - b.order) }
  livePhrases(boardId: string) { return [...this.phrases.values()].filter((p) => p.boardId === boardId && !p.deletedAt).sort((a, b) => a.order - b.order) }
  addBoard(name: string, at: number) { const id = newId(); this.boards.set(id, { id, name, order: this.liveBoards().length, updatedAt: at, deletedAt: null }); return id }
  addPhrase(boardId: string, text: string, at: number) { const id = newId(); this.phrases.set(id, { id, boardId, text, order: this.livePhrases(boardId).length, uses: 0, updatedAt: at, deletedAt: null }); return id }
  removePhrase(id: string, at: number) { const p = this.phrases.get(id)!; this.phrases.set(id, { ...p, deletedAt: at, updatedAt: at }) }
  removeBoard(id: string, at: number) {
    this.boards.set(id, { ...this.boards.get(id)!, deletedAt: at, updatedAt: at })
    for (const p of this.phrases.values()) if (p.boardId === id && !p.deletedAt) this.phrases.set(p.id, { ...p, deletedAt: at, updatedAt: at })
  }
}

/** Fake Supabase: enforces the FK (phrase.board_id → board) and the 0005 caps trigger, like the real database. */
class Cloud implements PhraseRemote {
  boards = new Map<string, RemoteBoardRow>()
  phrases = new Map<string, RemotePhraseRow>()
  calls: string[] = []
  failNext: { code?: string; message?: string } | null = null
  async fetchBoards() { this.calls.push('fetchBoards'); return { rows: [...this.boards.values()] } }
  async fetchPhrases() { this.calls.push('fetchPhrases'); return { rows: [...this.phrases.values()] } }
  async upsertBoards(rows: RemoteBoardRow[]) {
    this.calls.push(`upsertBoards:${rows.length}`)
    if (this.failNext) { const e = this.failNext; this.failNext = null; return e }
    for (const r of rows) this.boards.set(r.id, r)
    const live = [...this.boards.values()].filter((b) => !b.deleted_at).length
    if (live > PHRASE_LIMITS.maxBoards) return { code: '23514', message: 'board_cap' }
    return null
  }
  async upsertPhrases(rows: RemotePhraseRow[]) {
    this.calls.push(`upsertPhrases:${rows.length}`)
    if (this.failNext) { const e = this.failNext; this.failNext = null; return e }
    for (const r of rows) if (!this.boards.has(r.board_id)) return { code: '23503', message: 'fk violation' }
    for (const r of rows) this.phrases.set(r.id, r)
    return null
  }
  liveBoardNames() { return [...this.boards.values()].filter((b) => !b.deleted_at).map((b) => b.name) }
}

const sync = (d: Device, c: Cloud, now = T0) => runPhraseSync({ store: d, remote: c, userId: USER, now: () => now })

describe('E48 ids', () => {
  it('seed ids are deterministic, valid UUIDs, and distinct', () => {
    const a = buildSeed(), b = buildSeed()
    expect(a.boards.map((x) => x.id)).toEqual(b.boards.map((x) => x.id))
    const ids = [...a.boards, ...a.phrases].map((x) => x.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(isUuid)).toBe(true)
    expect(deterministicUuid('x')).toBe(deterministicUuid('x'))
    expect(deterministicUuid('x')).not.toBe(deterministicUuid('y'))
  })
  it('newId always yields a UUID (even when crypto.randomUUID is unavailable)', () => {
    expect(isUuid(newId())).toBe(true)
    const orig = globalThis.crypto.randomUUID
    // @ts-expect-error simulate an old browser
    globalThis.crypto.randomUUID = undefined
    try { expect(isUuid(newId())).toBe(true) } finally { globalThis.crypto.randomUUID = orig }
  })
})

describe('E48 legacy migration (Dexie v2 → v3)', () => {
  it('re-keys untouched defaults to seed ids with updatedAt 0, stamps user content, replaces non-UUID ids, drops orphans', () => {
    const boards = [{ id: 'abc123', name: 'Quick', order: 0 }, { id: 'mine1', name: 'Work', order: 1 }]
    const phrases = [
      { id: 'p1', boardId: 'abc123', text: 'Yes', order: 0, uses: 5 },
      { id: 'p2', boardId: 'abc123', text: 'My custom phrase', order: 1, uses: 0 },
      { id: 'p3', boardId: 'mine1', text: 'Meeting at ten', order: 0, uses: 1, cacheable: true },
      { id: 'p4', boardId: 'ghost', text: 'orphan', order: 0, uses: 0 },
    ]
    const m = migrateLegacy(boards, phrases, T0)
    const quick = m.boards.find((b) => b.name === 'Quick')!
    expect(quick.id).toBe(seedBoardId('Quick'))
    expect(quick.updatedAt).toBe(0)
    const work = m.boards.find((b) => b.name === 'Work')!
    expect(isUuid(work.id)).toBe(true)
    expect(work.updatedAt).toBe(T0)
    const yes = m.phrases.find((p) => p.text === 'Yes')!
    expect(yes.updatedAt).toBe(0)
    expect(yes.uses).toBe(5)
    expect(m.phrases.find((p) => p.text === 'My custom phrase')!.updatedAt).toBe(T0)
    expect(m.phrases.find((p) => p.text === 'Meeting at ten')!.cacheable).toBe(true)
    expect(m.phrases.some((p) => p.text === 'orphan')).toBe(false)
    expect(m.phrases.every((p) => isUuid(p.id) && isUuid(p.boardId))).toBe(true)
  })
  it('a default phrase the user opted into caching counts as an edit', () => {
    const m = migrateLegacy([{ id: 'b', name: 'Quick', order: 0 }], [{ id: 'p', boardId: 'b', text: 'Yes', order: 0, uses: 0, cacheable: true }], T0)
    expect(m.phrases[0].updatedAt).toBe(T0)
  })
  it('clamps oversize legacy text/names to the server limits', () => {
    const m = migrateLegacy([{ id: 'b', name: 'N'.repeat(100), order: 0 }], [{ id: 'p', boardId: 'b', text: 'x'.repeat(900), order: 0, uses: 0 }], T0)
    expect(m.boards[0].name.length).toBe(PHRASE_LIMITS.boardName)
    expect(m.phrases[0].text.length).toBe(PHRASE_LIMITS.phraseText)
  })
})

describe('E48 remote validation (cloud rows are untrusted)', () => {
  const good = { id: deterministicUuid('b'), name: 'Board', sort: 1, updated_at: new Date(T0).toISOString(), deleted_at: null }
  it('accepts a good board and rejects malformed ones', () => {
    expect(boardFromRemote(good, T0)).toMatchObject({ name: 'Board', order: 1, updatedAt: T0, deletedAt: null })
    for (const bad of [null, 'x', { ...good, id: 'nope' }, { ...good, name: 5 }, { ...good, name: 'x'.repeat(41) }, { ...good, sort: -1 }, { ...good, sort: 1.5 }, { ...good, updated_at: 'garbage' }, { ...good, deleted_at: 'garbage' }]) {
      expect(boardFromRemote(bad, T0)).toBeNull()
    }
  })
  it('accepts a good phrase and rejects malformed ones', () => {
    const p = { id: deterministicUuid('p'), board_id: good.id, text: 'Hi', sort: 0, cacheable: false, uses: 3, updated_at: good.updated_at, deleted_at: null }
    expect(phraseFromRemote(p, T0)).toMatchObject({ text: 'Hi', uses: 3, boardId: good.id })
    for (const bad of [{ ...p, board_id: 'x' }, { ...p, text: 'x'.repeat(401) }, { ...p, uses: -1 }, { ...p, cacheable: 'yes' }, { ...p, text: null }]) expect(phraseFromRemote(bad, T0)).toBeNull()
  })
  it('clamps a far-future clock so one skewed device cannot win every future conflict', () => {
    const b = boardFromRemote({ ...good, updated_at: new Date(T0 + 10 * 86_400_000).toISOString() }, T0)!
    expect(b.updatedAt).toBeLessThanOrEqual(T0 + 5 * 60_000)
  })
  it('round-trips through the remote shape', () => {
    const b: LBoard = { id: good.id, name: 'Board', order: 2, updatedAt: T0, deletedAt: null }
    expect(boardFromRemote(toRemoteBoard(b, USER), T0)).toEqual(b)
    const p: LPhrase = { id: deterministicUuid('p'), boardId: b.id, text: 'Hi', order: 0, uses: 2, cacheable: true, updatedAt: T0, deletedAt: T0 + 1 }
    expect(phraseFromRemote(toRemotePhrase(p, USER), T0 + 10)).toEqual(p)
  })
})

describe('E48 merge (last-writer-wins per row)', () => {
  it('a fresh device with only defaults never uploads defaults and never overwrites the cloud', async () => {
    const cloud = new Cloud()
    const fresh = new Device()
    const r = await sync(fresh, cloud)
    expect(r.ok).toBe(true)
    expect(r.pushed).toBe(0)
    expect(cloud.boards.size).toBe(0)
  })
  it('first device edits → cloud; second FRESH device pulls the user data and keeps ONE copy of the defaults', async () => {
    const cloud = new Cloud()
    const a = new Device()
    const work = a.addBoard('Work', T0 + 1000)
    a.addPhrase(work, 'Meeting at ten', T0 + 1000)
    expect((await sync(a, cloud, T0 + 2000)).ok).toBe(true)
    expect(cloud.liveBoardNames()).toContain('Work')
    expect(cloud.phrases.size).toBe(1)

    const b = new Device()
    const r = await sync(b, cloud, T0 + 3000)
    expect(r.ok).toBe(true)
    expect(b.liveBoards().map((x) => x.name).sort()).toEqual(['Needs', 'Quick', 'Social', 'Work'])
    expect(b.liveBoards().filter((x) => x.name === 'Quick')).toHaveLength(1)
    expect(b.livePhrases(work).map((p) => p.text)).toEqual(['Meeting at ten'])
  })
  it('a deletion on device A propagates to device B (tombstone), and B does not resurrect it', async () => {
    const cloud = new Cloud()
    const a = new Device()
    const id = a.addPhrase([...a.boards.values()][0].id, 'Temporary', T0 + 1000)
    await sync(a, cloud, T0 + 1500)
    const b = new Device()
    await sync(b, cloud, T0 + 2000)
    expect(b.phrases.get(id)?.deletedAt).toBeFalsy()
    a.removePhrase(id, T0 + 3000)
    await sync(a, cloud, T0 + 3500)
    await sync(b, cloud, T0 + 4000)
    expect(b.phrases.get(id)?.deletedAt).toBeTruthy()
    await sync(b, cloud, T0 + 5000)
    await sync(a, cloud, T0 + 6000)
    expect(a.phrases.get(id)?.deletedAt).toBeTruthy()
    expect(cloud.phrases.get(id)?.deleted_at).toBeTruthy()
  })
  it('a newer edit beats an older delete (and vice versa); ties go to the cloud copy', async () => {
    const cloud = new Cloud()
    const a = new Device(), b = new Device()
    const bid = [...a.boards.values()][0].id
    const id = a.addPhrase(bid, 'v1', T0 + 1000)
    await sync(a, cloud, T0 + 1100)
    await sync(b, cloud, T0 + 1200)
    a.removePhrase(id, T0 + 2000)
    b.phrases.set(id, { ...b.phrases.get(id)!, text: 'v2 edited', updatedAt: T0 + 3000 })
    await sync(a, cloud, T0 + 2100)
    await sync(b, cloud, T0 + 3100)
    await sync(a, cloud, T0 + 3200)
    expect(a.phrases.get(id)).toMatchObject({ text: 'v2 edited', deletedAt: null })
    // tie → cloud wins
    const L: LPhrase = { id, boardId: bid, text: 'local', order: 0, uses: 0, updatedAt: 5000, deletedAt: null }
    const R: LPhrase = { ...L, text: 'cloud' }
    const plan = planSync([{ id: bid, name: 'x', order: 0, updatedAt: 1, deletedAt: null }], [L], [{ id: bid, name: 'x', order: 0, updatedAt: 1, deletedAt: null }], [R])
    expect(plan.localPhrases[0].row.text).toBe('cloud')
    expect(plan.remotePhrases).toHaveLength(0)
  })
  it('uses merges as max() and never triggers an upload by itself', async () => {
    const cloud = new Cloud()
    const a = new Device()
    const bid = [...a.boards.values()][0].id
    const id = a.addPhrase(bid, 'counter', T0 + 1000)
    await sync(a, cloud, T0 + 1100)
    const b = new Device()
    await sync(b, cloud, T0 + 1200)
    b.phrases.set(id, { ...b.phrases.get(id)!, uses: 7 }) // used 7 times on B, updatedAt unchanged
    cloud.calls.length = 0
    await sync(b, cloud, T0 + 1300)
    expect(cloud.calls.some((c) => c.startsWith('upsert'))).toBe(false) // a counter alone does not upload
    a.phrases.set(id, { ...a.phrases.get(id)!, uses: 3 })
    await sync(a, cloud, T0 + 1400)
    expect(a.phrases.get(id)!.uses).toBe(3)
  })
  it('deleting a board tombstones its phrases on every device', async () => {
    const cloud = new Cloud()
    const a = new Device()
    const work = a.addBoard('Work', T0 + 1000)
    const p1 = a.addPhrase(work, 'one', T0 + 1000)
    await sync(a, cloud, T0 + 1100)
    const b = new Device()
    await sync(b, cloud, T0 + 1200)
    a.removeBoard(work, T0 + 2000)
    await sync(a, cloud, T0 + 2100)
    await sync(b, cloud, T0 + 2200)
    expect(b.boards.get(work)?.deletedAt).toBeTruthy()
    expect(b.phrases.get(p1)?.deletedAt).toBeTruthy()
    expect(b.liveBoards().some((x) => x.id === work)).toBe(false)
  })
  it('a phrase added on B to a board that A deleted is cascaded away instead of resurrecting the board', () => {
    const bid = deterministicUuid('bd')
    const board: LBoard = { id: bid, name: 'Gone', order: 0, updatedAt: 1000, deletedAt: 2000 }
    const stale: LPhrase = { id: deterministicUuid('ph'), boardId: bid, text: 'late', order: 0, uses: 0, updatedAt: 1500, deletedAt: null }
    const plan = planSync([{ ...board, deletedAt: null, updatedAt: 500 }], [stale], [board], [])
    expect(plan.remotePhrases[0]?.deletedAt).toBeTruthy()
    expect(plan.localBoards[0].row.deletedAt).toBeTruthy()
  })
  it('uploads the board before any phrase that needs it (FK), even when only the phrase changed', async () => {
    const cloud = new Cloud()
    const a = new Device()
    const quick = seedBoardId('Quick')
    a.addPhrase(quick, 'added to a default board', T0 + 1000) // board itself is an untouched default (updatedAt 0)
    const r = await sync(a, cloud, T0 + 2000)
    expect(r.ok).toBe(true)
    expect(cloud.boards.has(quick)).toBe(true)
    expect(cloud.phrases.size).toBe(1)
  })
  it('two devices that independently seeded do not duplicate the default boards', async () => {
    const cloud = new Cloud()
    const a = new Device(), b = new Device()
    a.addPhrase(seedBoardId('Quick'), 'a-only', T0 + 1000)
    b.addPhrase(seedBoardId('Needs'), 'b-only', T0 + 1000)
    await sync(a, cloud, T0 + 2000)
    await sync(b, cloud, T0 + 3000)
    await sync(a, cloud, T0 + 4000)
    for (const d of [a, b]) expect(d.liveBoards().map((x) => x.name).sort()).toEqual(['Needs', 'Quick', 'Social'])
    // Only boards that were edited, or that an uploaded phrase needs (FK), reach the cloud: untouched 'Social' stays local-only, once.
    expect(cloud.liveBoardNames().sort()).toEqual(['Needs', 'Quick'])
    expect(a.livePhrases(seedBoardId('Needs')).some((p) => p.text === 'b-only')).toBe(true)
    expect(b.livePhrases(seedBoardId('Quick')).some((p) => p.text === 'a-only')).toBe(true)
  })
  it('drops phrases whose board is unknown on both sides (orphans) instead of failing the FK', () => {
    const orphan: LPhrase = { id: deterministicUuid('o'), boardId: deterministicUuid('nobody'), text: 'x', order: 0, uses: 0, updatedAt: 9, deletedAt: null }
    const plan = planSync([], [orphan], [], [])
    expect(plan.remotePhrases).toHaveLength(0)
    expect(plan.dropLocalPhraseIds).toEqual([orphan.id])
  })
  it('is idempotent: a second sync does no work', async () => {
    const cloud = new Cloud()
    const a = new Device()
    a.addPhrase(seedBoardId('Quick'), 'x', T0 + 1000)
    await sync(a, cloud, T0 + 2000)
    const r = await sync(a, cloud, T0 + 3000)
    expect(r).toMatchObject({ ok: true, pulled: 0 })
  })
})

describe('E48 race guard, errors and caps', () => {
  it('shouldApply refuses to overwrite a row the user edited while the sync was in flight', () => {
    expect(shouldApply({ updatedAt: 100 }, 100)).toBe(true)
    expect(shouldApply({ updatedAt: 200 }, 100)).toBe(false)
    expect(shouldApply(undefined, null)).toBe(true)
    expect(shouldApply({ updatedAt: 1 }, null)).toBe(false)
    expect(shouldApply(undefined, 5)).toBe(false)
  })
  it('an edit made during the pull is not lost', async () => {
    const cloud = new Cloud()
    const a = new Device()
    const bid = seedBoardId('Quick')
    const id = a.addPhrase(bid, 'orig', T0 + 1000)
    await sync(a, cloud, T0 + 1100)
    const b = new Device()
    await sync(b, cloud, T0 + 1200)
    // cloud gets a newer version from A
    a.phrases.set(id, { ...a.phrases.get(id)!, text: 'from A', updatedAt: T0 + 2000 })
    await sync(a, cloud, T0 + 2100)
    // while B is syncing, the user edits locally (after readAll, before apply)
    const origRead = b.readAll.bind(b)
    b.readAll = async () => {
      const snap = await origRead()
      b.phrases.set(id, { ...b.phrases.get(id)!, text: 'edited on B mid-sync', updatedAt: T0 + 2500 })
      return snap
    }
    await sync(b, cloud, T0 + 2600)
    expect(b.phrases.get(id)!.text).toBe('edited on B mid-sync') // the guard kept the newer local edit
    b.readAll = origRead
    await sync(b, cloud, T0 + 2700)
    expect(cloud.phrases.get(id)!.text).toBe('edited on B mid-sync') // …and it is uploaded on the next pass
  })
  it('a failed upload is surfaced (not swallowed) and succeeds on retry', async () => {
    const cloud = new Cloud()
    const a = new Device()
    a.addPhrase(seedBoardId('Quick'), 'keep me', T0 + 1000)
    cloud.failNext = { code: '57014', message: 'timeout' }
    const r1 = await sync(a, cloud, T0 + 2000)
    expect(r1.ok).toBe(false)
    expect(r1.message).toMatch(/kept on this device/)
    expect([...a.phrases.values()].some((p) => p.text === 'keep me' && !p.deletedAt)).toBe(true)
    const r2 = await sync(a, cloud, T0 + 3000)
    expect(r2.ok).toBe(true)
    expect([...cloud.phrases.values()].some((p) => p.text === 'keep me')).toBe(true)
  })
  it('a fetch error is reported and nothing is changed', async () => {
    const a = new Device()
    const before = JSON.stringify(await a.readAll())
    const r = await runPhraseSync({
      store: a, userId: USER,
      remote: { fetchBoards: async () => ({ rows: [], error: { code: '42P01' } }), fetchPhrases: async () => ({ rows: [] }), upsertBoards: async () => null, upsertPhrases: async () => null },
    })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/migrations/)
    expect(JSON.stringify(await a.readAll())).toBe(before)
  })
  it('over the free-tier cap → clear message, no partial upload', async () => {
    const cloud = new Cloud()
    const a = new Device()
    for (let i = 0; i < PHRASE_LIMITS.maxBoards + 2; i++) a.addBoard(`B${i}`, T0 + 1000 + i)
    const r = await sync(a, cloud, T0 + 9000)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('cap')
    expect(cloud.boards.size).toBe(0)
  })
  it('the server cap error maps to a human message', async () => {
    const cloud = new Cloud()
    const a = new Device()
    a.addPhrase(seedBoardId('Quick'), 'x', T0 + 1000)
    cloud.failNext = { code: '23514', message: 'phrase_cap' }
    const r = await sync(a, cloud, T0 + 2000)
    expect(r.message).toMatch(/limit of 600 phrases/)
  })
  it('ignores malformed cloud rows without failing the whole sync', async () => {
    const cloud = new Cloud()
    cloud.boards.set('bad', { id: 'bad' } as unknown as RemoteBoardRow)
    const a = new Device()
    expect((await sync(a, cloud)).ok).toBe(true)
  })
  it('seed content stays in sync with the exported SEED', () => {
    const s = buildSeed()
    expect(s.boards.map((b) => b.name)).toEqual(Object.keys(SEED))
    expect(s.phrases.length).toBe(Object.values(SEED).flat().length)
  })
})
