/**
 * Partner-link helpers that are safe in the browser AND on the server (no secrets, no `server-only`).
 *
 *   invite  rvi1.<room>.<jti>.<exp>.<sig>   single use, 30 min, carried in the URL fragment
 *   claim   rvc1.<room>.<identity>.<exp>.<sig>   issued when an invite is consumed; lets the SAME partner device re-join
 *           (page reload, phone locked, network change) without a second invite. Kept in sessionStorage only.
 */
import { ROOM_RE } from './spend-refs'

export const INVITE_PREFIX = 'rvi1'
export const CLAIM_PREFIX = 'rvc1'
export const PARTNER_IDENTITY_RE = /^partner-[a-f0-9]{12}$/

/** Syntax only. NOT trusted until the HMAC is verified against the owner read from the room. */
export function parseInviteSyntax(invite: string): { room: string; jti: string; exp: number; sig: string } | null {
  if (typeof invite !== 'string') return null
  const parts = invite.split('.')
  if (parts.length !== 5 || parts[0] !== INVITE_PREFIX) return null
  const [, room, jti, expS, sig] = parts
  const exp = Number(expS)
  if (!ROOM_RE.test(room) || !/^[a-f0-9]{24}$/.test(jti) || !Number.isFinite(exp) || !/^[a-f0-9]{64}$/.test(sig)) return null
  return { room, jti, exp, sig }
}

export function parseClaimSyntax(claim: string): { room: string; identity: string; exp: number; sig: string } | null {
  if (typeof claim !== 'string') return null
  const parts = claim.split('.')
  if (parts.length !== 5 || parts[0] !== CLAIM_PREFIX) return null
  const [, room, identity, expS, sig] = parts
  const exp = Number(expS)
  if (!ROOM_RE.test(room) || !PARTNER_IDENTITY_RE.test(identity) || !Number.isFinite(exp) || !/^[a-f0-9]{64}$/.test(sig)) return null
  return { room, identity, exp, sig }
}

/**
 * Read the invite out of `location.hash`. Never throws: a malformed percent-escape (`%E0%A4%A`, a link cut by a chat app)
 * used to make `decodeURIComponent` throw inside an effect and blank the whole page. Accepts `#<invite>`, `#invite=<invite>`,
 * a once- or twice-encoded value, and strips whitespace / trailing punctuation that messengers add.
 */
export function parseInviteFromHash(hash: string | null | undefined): string {
  let raw = String(hash ?? '').trim().replace(/^#/, '')
  if (/^invite=/i.test(raw)) raw = raw.slice('invite='.length)
  for (let i = 0; i < 2; i++) {
    try {
      const d = decodeURIComponent(raw)
      if (d === raw) break
      raw = d
    } catch {
      break
    }
  }
  return raw.replace(/\s+/g, '').replace(/[)>\].,;:!?"'`]+$/, '')
}

export type InviteState = 'missing' | 'malformed' | 'expired' | 'valid'
export interface InviteInfo { state: InviteState; room?: string; exp?: number; remainingMs?: number }

export function inviteInfo(invite: string, now = Date.now()): InviteInfo {
  if (!invite) return { state: 'missing' }
  const p = parseInviteSyntax(invite)
  if (!p) return { state: 'malformed' }
  const remainingMs = p.exp - now
  return remainingMs <= 0 ? { state: 'expired', room: p.room, exp: p.exp, remainingMs: 0 } : { state: 'valid', room: p.room, exp: p.exp, remainingMs }
}

export const inviteExpiresAt = (invite: string | null | undefined): number | null => (invite ? parseInviteSyntax(invite)?.exp ?? null : null)

/** "29 min 40 s", "45 s", "expired". */
export function formatRemaining(ms: number): string {
  if (!(ms > 0)) return 'expired'
  const s = Math.ceil(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`
}

// ------------------------------------------------------------------------------------------------ partner-side claim store
const CLAIM_KEY = 'revoice.partner.claim'
export interface StoredClaim { claim: string; room: string; label: string; at: number }

export function readStoredClaim(storage: Pick<Storage, 'getItem' | 'removeItem'> | undefined, now = Date.now()): StoredClaim | null {
  try {
    const raw = storage?.getItem(CLAIM_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as StoredClaim
    const p = parseClaimSyntax(c.claim)
    if (!p || p.room !== c.room || p.exp <= now) {
      storage?.removeItem(CLAIM_KEY)
      return null
    }
    return c
  } catch {
    return null
  }
}
export function writeStoredClaim(storage: Pick<Storage, 'setItem'> | undefined, c: StoredClaim) {
  try { storage?.setItem(CLAIM_KEY, JSON.stringify(c)) } catch {}
}
export function clearStoredClaim(storage: Pick<Storage, 'removeItem'> | undefined) {
  try { storage?.removeItem(CLAIM_KEY) } catch {}
}
