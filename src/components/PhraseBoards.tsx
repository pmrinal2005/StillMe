'use client'
import { useEffect, useState } from 'react'
import { db, ensureSeed, uid, type Board, type Phrase } from '@/lib/client/db'
import { Icon } from './ui/Icon'

/** Local phrase boards: work offline and without any AI. Selecting a phrase loads it into the composer for review. */
export function PhraseBoards({ onPick, cacheAllowed = false }: { onPick: (text: string, opts: { cacheable: boolean }) => void; cacheAllowed?: boolean }) {
  const [boards, setBoards] = useState<Board[]>([])
  const [phrases, setPhrases] = useState<Phrase[]>([])
  const [active, setActive] = useState<string>('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [newBoard, setNewBoard] = useState('')

  const load = async () => {
    await ensureSeed()
    const b = await db.boards.orderBy('order').toArray()
    setBoards(b)
    setActive((a) => a || b[0]?.id || '')
  }
  useEffect(() => {
    load()
  }, [])
  useEffect(() => {
    if (active) db.phrases.where('boardId').equals(active).sortBy('order').then(setPhrases)
  }, [active])

  const addPhrase = async () => {
    const text = draft.trim()
    if (!text || !active) return
    await db.phrases.add({ id: uid(), boardId: active, text, order: phrases.length, uses: 0 })
    setDraft('')
    setPhrases(await db.phrases.where('boardId').equals(active).sortBy('order'))
  }
  const removePhrase = async (id: string) => {
    await db.phrases.delete(id)
    setPhrases(await db.phrases.where('boardId').equals(active).sortBy('order'))
  }
  const addBoard = async () => {
    const name = newBoard.trim()
    if (!name) return
    const id = uid()
    await db.boards.add({ id, name, order: boards.length })
    setNewBoard('')
    await load()
    setActive(id)
  }
  const pick = async (p: Phrase) => {
    await db.phrases.update(p.id, { uses: p.uses + 1 })
    onPick(p.text, { cacheable: !!p.cacheable })
  }
  const toggleCache = async (p: Phrase) => {
    await db.phrases.update(p.id, { cacheable: !p.cacheable })
    setPhrases(await db.phrases.where('boardId').equals(active).sortBy('order'))
  }

  return (
    <section id="phrase-boards" aria-labelledby="boards-h" className="rv-glass rv-enter grid content-start gap-3 p-4 sm:p-5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="rv-eyebrow">Works offline · no AI</p>
          <h2 id="boards-h" className="rv-section-title flex items-center gap-2"><Icon name="grid" size={17} /> Phrase boards</h2>
        </div>
        <button className="rv-btn text-sm" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
          <Icon name={editing ? 'check' : 'edit'} size={15} /> {editing ? 'Done editing' : 'Edit boards'}
        </button>
      </header>
      <div role="tablist" aria-label="Boards" className="rv-scroll-x -mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible">
        {boards.map((b) => (
          <button key={b.id} role="tab" aria-selected={active === b.id} data-scan className="rv-chip shrink-0" onClick={() => setActive(b.id)}>
            {b.name}
          </button>
        ))}
      </div>
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
            <input className="rv-input min-w-0 flex-1" placeholder="New phrase…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addPhrase()} />
            <button className="rv-btn" onClick={addPhrase}><Icon name="plus" size={15} /> Add</button>
          </label>
          <label className="flex gap-2">
            <span className="sr-only">New board name</span>
            <input className="rv-input min-w-0 flex-1" placeholder="New board…" value={newBoard} onChange={(e) => setNewBoard(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addBoard()} />
            <button className="rv-btn" onClick={addBoard}><Icon name="plus" size={15} /> Create</button>
          </label>
        </div>
      )}
    </section>
  )
}
