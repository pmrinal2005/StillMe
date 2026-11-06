'use client'
import { useEffect, useId, useRef, useState } from 'react'
import type { StatusResponse } from '@/lib/client/api'
import type { AuthProviders, OAuthProvider } from '@/lib/auth-providers'
import { AuthError, consumeAuthRedirectError, getAuthProviders, getSupabase, signInAnonymously, signInWithEmail, signInWithOAuth } from '@/lib/client/supabase'
import { Icon } from './ui/Icon'

const LABEL: Record<OAuthProvider, string> = { github: 'GitHub', google: 'Google' }

/**
 * B8 — sign-in that never sends the user to a dead provider.
 *  - Offers ONLY the methods the Supabase project has enabled (read from the public /auth/v1/settings).
 *  - Email one-time link when email is enabled (rate-limit errors are explained, not shown raw).
 *  - Guest mode: if not signed in, the server issues a capped guest identity, so typing, phrase boards
 *    and library-voice speech keep working; this component just labels it.
 *  - OAuth/email redirect errors (?error_description=…) are shown as a readable alert, then cleared.
 */
export function AuthControls({ needsSignIn, status, onBeforeSignOut }: { needsSignIn: boolean; status: StatusResponse | null; onBeforeSignOut?: () => Promise<void> }) {
  const sb = getSupabase()
  const [providers, setProviders] = useState<AuthProviders | null>(null)
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const panelId = useId()
  const firstRef = useRef<HTMLButtonElement | HTMLInputElement | null>(null)

  useEffect(() => {
    const err = consumeAuthRedirectError()
    if (err) {
      setMsg({ kind: 'err', text: `Sign-in did not complete: ${err}` })
      setOpen(true)
    }
    if (sb) void getAuthProviders().then(setProviders)
  }, [sb])

  useEffect(() => {
    if (open) requestAnimationFrame(() => firstRef.current?.focus())
  }, [open])

  if (!sb) return <span className="rv-badge"><Icon name="user" size={13} /> Local prototype</span>

  const kind = status?.identity.kind
  if (kind === 'supabase') {
    return (
      <button
        className="rv-btn text-sm"
        onClick={() => {
          // D #36: end the listening session FIRST (it needs the still-valid token to settle its minutes and close the
          // room), clear the ticket, then drop the session. Signing out used to leave the billed session running.
          void (async () => {
            try {
              await onBeforeSignOut?.()
            } catch {}
            await sb.auth.signOut()
          })()
        }}
      >
        <Icon name="logout" size={15} /> Sign out
      </button>
    )
  }

  const run = async (fn: () => Promise<void>, okText?: string) => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
      if (okText) setMsg({ kind: 'ok', text: okText })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof AuthError ? e.message : 'Sign-in failed. Typing and phrases still work.' })
    } finally {
      setBusy(false)
    }
  }

  const oauth = providers?.oauth ?? []
  const nothingEnabled = providers?.reachable && !oauth.length && !providers.email && !providers.anonymous

  return (
    <div className="rv-auth relative flex flex-wrap items-center justify-end gap-2 text-sm">
      {kind === 'guest' && <span className="rv-badge rv-badge-warn" title="Typing, phrase boards and library voices work. Listening, cloned voices and phone need an account."><Icon name="user" size={13} /> Guest · limited</span>}
      {needsSignIn && kind !== 'guest' && <span className="rv-muted">Session expired.</span>}
      <button className="rv-btn text-sm" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        <Icon name="user" size={15} /> Sign in
      </button>
      {open && (
        <div id={panelId} role="dialog" aria-label="Sign in" className="rv-glass rv-glass-strong rv-pop rv-auth-panel grid gap-3 p-4">
          <p className="rv-muted text-xs">Sign in for listening sessions, cloned voices and larger daily limits. Typing, phrase boards and library voices work without it.</p>
          {!providers && <p className="rv-muted text-xs" role="status">Checking sign-in options…</p>}
          {providers && !providers.reachable && <p className="rv-alert rv-alert-warn text-xs" role="status"><Icon name="alert" size={14} /> The sign-in service is unreachable (the Supabase project may be paused). You can keep using ReVOICE as a guest.</p>}
          {nothingEnabled && <p className="rv-alert rv-alert-warn text-xs" role="status"><Icon name="alert" size={14} /> No sign-in method is enabled for this deployment yet. The owner must enable GitHub, Google or email in Supabase → Authentication → Providers.</p>}
          {oauth.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {oauth.map((p, i) => (
                <button key={p} ref={i === 0 ? (el) => { firstRef.current = el } : undefined} className="rv-btn" disabled={busy} onClick={() => run(() => signInWithOAuth(p))}>
                  <Icon name="link" size={15} /> Continue with {LABEL[p]}
                </button>
              ))}
            </div>
          )}
          {providers?.email && !providers.signupDisabled && (
            <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (email.trim()) void run(() => signInWithEmail(email.trim()), `Check ${email.trim()} for a sign-in link.`) }}>
              <label htmlFor={`${panelId}-email`} className="text-xs font-semibold">Email me a sign-in link</label>
              <div className="flex flex-col gap-2 min-[420px]:flex-row">
                <input id={`${panelId}-email`} ref={oauth.length ? undefined : (el) => { firstRef.current = el }} type="email" autoComplete="email" required className="rv-input min-w-0 flex-1" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                <button type="submit" className="rv-btn rv-btn-primary" disabled={busy || !email.trim()}><Icon name="send" size={15} /> Send link</button>
              </div>
            </form>
          )}
          {providers?.anonymous && (
            <button className="rv-btn text-sm" disabled={busy} onClick={() => run(() => signInAnonymously())}><Icon name="user" size={15} /> Continue anonymously</button>
          )}
          {msg && <p role={msg.kind === 'err' ? 'alert' : 'status'} className={`rv-alert text-xs ${msg.kind === 'err' ? 'rv-alert-warn' : ''}`}>{msg.text}</p>}
          <button className="rv-btn text-xs justify-self-end" onClick={() => setOpen(false)}>Close</button>
        </div>
      )}
    </div>
  )
}
