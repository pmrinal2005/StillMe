'use client'
/**
 * Optional inbound phone bridge (owner side). Only shown when the server has telephony enabled
 * AND the owner has an active listening session. The code is single use, expires in 5 minutes,
 * and binds the call to THIS session — caller ID alone never connects a call.
 */
import { useEffect, useState } from 'react'
import { api, ApiError } from '@/lib/client/api'

export function PhonePanel({ active }: { active: boolean }) {
  const [pair, setPair] = useState<Awaited<ReturnType<typeof api.phonePair>> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!pair) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [pair])
  useEffect(() => {
    if (!active) setPair(null)
  }, [active])

  const create = async () => {
    setErr(null)
    try {
      setPair(await api.phonePair())
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'error'
      setErr(code === 'phone_cap' ? 'The monthly phone allowance (40 minutes) is used.' : code === 'no_active_session' ? 'Start a listening session first.' : code === 'phone_disabled' ? 'Phone calling is not enabled on this server.' : `Could not create a code (${code}).`)
    }
  }
  const revoke = async () => {
    await api.phoneRevoke().catch(() => undefined)
    setPair(null)
  }

  const left = pair ? Math.max(0, Math.round((pair.expiresAt - now) / 1000)) : 0
  return (
    <section id="phone-panel" aria-labelledby="phone-h" className="rv-panel grid gap-2 p-3">
      <h3 id="phone-h" className="font-bold">Phone call (optional, inbound only)</h3>
      <p className="rv-muted text-sm">A known partner can call the included US number and enter a one-time code to join this session. Outbound calls and emergency calling are not available. Caller charges may apply.</p>
      {pair && left > 0 ? (
        <div role="status" className="grid gap-1">
          {pair.number && <p>Number: <strong>{pair.number}</strong></p>}
          <p className="text-3xl font-extrabold tracking-widest" aria-label={`Pairing code ${pair.code.split('').join(' ')}`}>{pair.code}</p>
          <p className="rv-muted text-sm">Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · this call may last up to {pair.maxCallMinutes} min · {pair.monthUsed}/{pair.monthCap} min used this month</p>
          <button className="rv-btn" onClick={revoke}>Cancel code</button>
        </div>
      ) : (
        <button data-scan className="rv-btn" disabled={!active} onClick={create}>📞 Create pairing code</button>
      )}
      {err && <p role="alert" style={{ color: 'var(--warn)' }}>{err}</p>}
    </section>
  )
}
