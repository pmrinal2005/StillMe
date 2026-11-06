'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  addBoardLocal, addPhraseLocal, bumpPhraseUse, ensureSeed, listBoards, listPhrases, removeBoardLocal, removePhraseLocal, setPhraseCacheable,
  type Board, type MutationResult, type Phrase,
} from '@/lib/client/db'
import { PHRASE_LIMITS } from '@/lib/phrase-sync'
import { Icon } from './ui/Icon'
import { usePhraseSync } from './usePhraseSync'

const REASONS: Record<string, string> = {
  empty: 'Type something first.',
  too_long: `Too long (limit ${PHRASE_LIMITS.phraseText} characters for a phrase, ${PHRASE_LIMITS.boardName} for a board name).`,
  cap: `Limit reached (${PHRASE_LIMITS.maxBoards} boards / ${PHRASE_LIMITS.maxPhrases} phrases). Delete some first.`,
  missing: 'That board no longer exists.',
}

/** Local phrase boards: work offline and without any AI. Selecting a phrase loads it into the composer for review. */
export function PhraseBoards({ onPick, cacheAllowed = false }: { onPick: (text: string, opts: { cacheable: boolean }) => void; cacheAllowed?: boolean }) {
  const [boards, setBoards] = useState<Board[]>([])
  const [phrases, setPhrases] = useState<Phrase[]>([])
  const [active, setActive] = useState<string>('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [newBoard, setNewBoard] = useState('')
  const [notice, setNotice] = useState('')
  const activeRef = useRef('')
  activeRef.current = active

  const reload = useCallback(async () => {
    await ensureSeed()
    const b = await listBoards()
    setBoards(b)
    // keep the selection unless that board vanished (deleted here or on another device)
    const cur = b.some((x) => x.id === activeRef.current) ? activeRef.current : b[0]?.id || ''
    setActive(cur)
    setPhrases(cur ? await listPhrases(cur) : [])
  }, [])
  const { sync, schedule, syncNow } = usePhraseSync(() => void reload())

  useEffect(() => {
    void reload()
  }, [reload])
  useEffect(() => {
    if (active) void listPhrases(active).then(setPhrases)
    else setPhrases([])
  }, [active])

  const done = async (r?: MutationResult) => {
    if (r && !r.ok) { setNotice(REASONS[r.reason] ?? 'Could not save.'); return false }
    setNotice('')
    await reload()
    schedule()
    return true
  }
  const addPhrase = async () => {
    if (!active) return
    const r = await addPhraseLocal(active, draft)
    if (await done(r)) setDraft('')
  }
  const removePhrase = async (id: string) => { await removePhraseLocal(id); await done() }
  const addBoard = async () => {
    const r = await addBoardLocal(newBoard)
    if (r.ok && r.id) { setNewBoard(''); setNotice(''); await reload(); setActive(r.id); schedule() }
    else await done(r)
  }
  const removeBoard = async (id: string) => {
    if (!window.confirm('Delete this board and all its phrases?')) return
    await removeBoardLocal(id)
    await done()
  }
  const pick = async (p: Phrase) => {
    await bumpPhraseUse(p.id) // a counter, not an edit: does not change updatedAt
    onPick(p.text, { cacheable: !!p.cacheable })
  }
  const toggleCache = async (p: Phrase) => {
    await setPhraseCacheable(p.id, !p.cacheable)
    await done()
  }

  return (
    <section id="phrase-boards" aria-labelledby="boards-h" className="rv-glass rv-enter grid content-start gap-3 p-4 sm:p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="rv-eyebrow">Works offline · no AI</p>
          <h2 id="boards-h" className="rv-section-title flex items-center gap-2"><Icon name="grid" size={17} /> Phrase boards</h2>
        </div>
        <p className="rv-muted text-xs" role="status" aria-live="polite" id="phrase-sync-status">
          Saved on this device
        </p>
        <button className="rv-btn text-sm" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
          <Icon name={editing ? 'check' : 'edit'} size={15} /> {editing ? 'Done editing' : 'Edit boards'}
        </button>
      </header>
      {sync.state === 'error' && (
        <p role="alert" id="phrase-sync-error" className="rv-card flex flex-wrap items-center gap-2 p-3 text-sm">
          <span className="min-w-0 flex-1">{sync.message}</span>
          <button className="rv-btn text-xs" onClick={() => void syncNow()}>Retry</button>
        </p>
      )}
      {notice && <p role="alert" className="text-sm" id="phrase-notice">{notice}</p>}
      <div role="tablist" aria-label="Boards" className="rv-scroll-x -mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
        {boards.map((b) => (
          <button key={b.id} role="tab" aria-selected={active === b.id} data-scan className="rv-chip shrink-0" onClick={() => setActive(b.id)}>
            {b.name}
          </button>
        ))}
      </div>
      {editing && active && (
        <button className="rv-btn rv-btn-danger justify-self-start text-xs" onClick={() => void removeBoard(active)} aria-label="Delete this board and its phrases">
          <Icon name="x" size={14} /> Delete this board
        </button>
      )}
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3" role="list">
        {phrases.map((p) => (
          <li key={p.id} className="flex gap-2">
            <button data-scan className="rv-tile flex-1" onClick={() => pick(p)}>
              {p.text}
              {p.cacheable && <span className="sr-only"> (cached)</span>}
            </button>
            {editing && (
              <button className="rv-btn text-xs" aria-pressed={!!p.cacheable} title="Allow saving the synthesized audio on this device (library voices only; never cloned voices)" onClick={() => toggleCache(p)}>
                {p.cacheable ? 'Cached ✓' : 'Cache'}
              </button>
            )}
            {editing && (
              <button className="rv-btn rv-btn-danger" aria-label={`Delete phrase: ${p.text}`} onClick={() => removePhrase(p.id)}>
                <Icon name="x" size={15} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {editing && (
        <p className="rv-muted text-xs">“Cache” stores the spoken audio of that phrase on this device for instant, offline-capable replay{cacheAllowed ? '' : ' (only with library voices — cloned-voice audio is never cached)'}.</p>
      )}
      {editing && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex gap-2">
            <span className="sr-only">New phrase</span>
            <input className="rv-input min-w-0 flex-1" maxLength={PHRASE_LIMITS.phraseText} placeholder="New phrase…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addPhrase()} />
            <button className="rv-btn" onClick={addPhrase}><Icon name="plus" size={15} /> Add</button>
          </label>
          <label className="flex gap-2">
            <span className="sr-only">New board name</span>
            <input className="rv-input min-w-0 flex-1" maxLength={PHRASE_LIMITS.boardName} placeholder="New board…" value={newBoard} onChange={(e) => setNewBoard(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addBoard()} />
            <button className="rv-btn" onClick={addBoard}><Icon name="plus" size={15} /> Create</button>
          </label>
        </div>
      )}
    </section>
  )
}
