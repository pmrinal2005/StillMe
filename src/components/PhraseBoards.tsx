'use client'
import { useEffect, useState } from 'react'
import { db, ensureSeed, uid, type Board, type Phrase } from '@/lib/client/db'

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
    <section id="phrase-boards" aria-labelledby="boards-h" className="rv-panel p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="boards-h" className="text-lg font-bold">Phrase boards</h2>
        <button className="rv-btn text-sm" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
          {editing ? 'Done editing' : 'Edit boards'}
        </button>
      </div>
      <div role="tablist" aria-label="Boards" className="mb-3 flex flex-wrap gap-2">
        {boards.map((b) => (
          <button key={b.id} role="tab" aria-selected={active === b.id} data-scan className="rv-btn text-sm" onClick={() => setActive(b.id)}>
            {b.name}
          </button>
        ))}
      </div>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="list">
        {phrases.map((p) => (
          <li key={p.id} className="flex gap-2">
            <button data-scan className="rv-btn flex-1 justify-start text-left" onClick={() => pick(p)}>
              {p.text}
            </button>
            {editing && (
              <button className="rv-btn text-sm" aria-pressed={!!p.cacheable} title="Allow saving the synthesized audio on this device (library voices only; never cloned voices)" onClick={() => toggleCache(p)}>
                {p.cacheable ? 'Cached ✓' : 'Cache'}
              </button>
            )}
            {editing && (
              <button className="rv-btn rv-btn-danger" aria-label={`Delete phrase: ${p.text}`} onClick={() => removePhrase(p.id)}>
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      {editing && (
        <p className="rv-muted mt-2 text-xs">“Cache” stores the spoken audio of that phrase on this device for instant, offline-capable replay{cacheAllowed ? '' : ' (only with library voices — cloned-voice audio is never cached)'}.</p>
      )}
      {editing && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="flex gap-2">
            <span className="sr-only">New phrase</span>
            <input className="rv-input flex-1" placeholder="New phrase…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addPhrase()} />
            <button className="rv-btn" onClick={addPhrase}>Add</button>
          </label>
          <label className="flex gap-2">
            <span className="sr-only">New board name</span>
            <input className="rv-input flex-1" placeholder="New board…" value={newBoard} onChange={(e) => setNewBoard(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addBoard()} />
            <button className="rv-btn" onClick={addBoard}>Create</button>
          </label>
        </div>
      )}
    </section>
  )
}
