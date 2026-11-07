'use client'
import { useEffect, useState } from 'react'
import { api, ApiError, getOperatorToken, setOperatorToken } from '@/lib/client/api'

/**
 * Optional operator access. There is no sign-in: the deployment owner may paste REVOICE_OPERATOR_TOKEN here to unlock
 * the spend-reconciliation panel. The token is kept only in this browser's localStorage and sent as `x-revoice-operator`.
 * Everyone else never needs this.
 */
export function OperatorAccess({ active, onChange }: { active: boolean; onChange: () => void }) {
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(false)
  const [resetMsg, setResetMsg] = useState<string | null>(null)
  useEffect(() => setValue(getOperatorToken()), [])
  return (
    <details id="operator-access" className="rv-glass px-4 py-2 text-sm" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="py-1 font-semibold">Owner tools {active ? '· unlocked' : ''}</summary>
      <form
        className="grid gap-2 py-2"
        onSubmit={(e) => {
          e.preventDefault()
          setOperatorToken(value)
          onChange()
        }}
      >
        <p className="rv-muted">Only for the person who deployed this site. Paste the operator token to see project spend and record provider figures. It stays in this browser.</p>
        <label className="grid" htmlFor="operator-token">Operator token
          <input id="operator-token" type="password" autoComplete="off" className="rv-input" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="rv-btn rv-btn-primary">Save</button>
          <button type="button" className="rv-btn" onClick={() => { setValue(''); setOperatorToken(''); onChange() }}>Clear</button>
          <button
            type="button"
            className="rv-btn"
            disabled={!active}
            title="Releases listening minutes that were reserved but never settled (fixes the “stt daily minutes” lockout)"
            onClick={async () => {
              setResetMsg(null)
              try {
                const r = await api.resetSttQuota()
                setResetMsg(`Listening quota reset: ${r.memoryMinutesCleared} min cleared on this instance${r.durableReservationsReleased !== null ? `, ${r.durableReservationsReleased} stored reservation(s) released` : ''}.`)
                onChange()
              } catch (err) {
                setResetMsg(`Could not reset (${err instanceof ApiError ? err.code : 'error'}).`)
              }
            }}
          >Reset listening quota</button>
        </div>
        {resetMsg && <p role="status" className="text-sm">{resetMsg}</p>}
      </form>
    </details>
  )
}
