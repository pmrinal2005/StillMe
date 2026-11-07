/**
 * TODO2 (partner link) + TODO3 (worker-less captions, mode-aware session end).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { AccessToken } from 'livekit-server-sdk'
import {
  clearStoredClaim, formatRemaining, inviteExpiresAt, inviteInfo, parseClaimSyntax, parseInviteFromHash, parseInviteSyntax, readStoredClaim, writeStoredClaim,
} from '@/lib/invite-link'
import { mapJoinError } from '@/lib/join-errors'
import { backgroundPolicy, OWNER_GONE_GRACE_S, ownerGoneGraceSeconds, relayDesired, roomTimeouts, workerAbsentAction } from '@/lib/session-policy'
import { isAssemblyStreamingUrl, isOwnerPeer, isPartnerPeer, RELAY_TURN_STRIDE } from '@/lib/relay'
import { RelayFromPartner, RelayToPartner } from '@/lib/contracts'

const root = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')

const ROOM = 'rv-' + 'a'.repeat(24)
const JTI = 'b'.repeat(24)
const SIG = 'c'.repeat(64)
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)
const invite = (exp = NOW + 30 * 60_000) => `rvi1.${ROOM}.${JTI}.${exp}.${SIG}`

describe('TODO2: hash parsing never throws', () => {
  it('parses plain, encoded, double-encoded and prefixed invites', () => {
    const inv = invite()
    expect(parseInviteFromHash('#' + inv)).toBe(inv)
    expect(parseInviteFromHash('#' + encodeURIComponent(inv))).toBe(inv)
    expect(parseInviteFromHash('#' + encodeURIComponent(encodeURIComponent(inv)))).toBe(inv)
    expect(parseInviteFromHash('#invite=' + inv)).toBe(inv)
  })
  it('strips whitespace and trailing punctuation that chat apps add', () => {
    const inv = invite()
    expect(parseInviteFromHash('#' + inv + ')')).toBe(inv)
    expect(parseInviteFromHash('#' + inv + '.')).toBe(inv)
    expect(parseInviteFromHash(`#${inv}%0A`)).toBe(inv)
  })
  it('a malformed percent escape (link cut mid-character) does NOT throw', () => {
    expect(() => parseInviteFromHash('#rvi1.%E0%A4%A')).not.toThrow()
    expect(() => parseInviteFromHash('#%')).not.toThrow()
    expect(() => parseInviteFromHash(null)).not.toThrow()
    expect(() => parseInviteFromHash(undefined)).not.toThrow()
    expect(parseInviteFromHash('')).toBe('')
  })
  it('the join page uses the safe parser, not a bare decodeURIComponent', () => {
    const page = read('src/app/join/page.tsx')
    expect(page).toMatch(/parseInviteFromHash\(window\.location\.hash\)/)
    expect(page).not.toMatch(/decodeURIComponent\(window\.location\.hash/)
  })
})

describe('TODO2: invite syntax + expiry display', () => {
  it('classifies missing / malformed / expired / valid', () => {
    expect(inviteInfo('', NOW).state).toBe('missing')
    expect(inviteInfo('garbage', NOW).state).toBe('malformed')
    expect(inviteInfo(`rvi1.${ROOM}.${JTI}.${NOW - 1000}.${SIG}`, NOW).state).toBe('expired')
    const v = inviteInfo(invite(NOW + 90_000), NOW)
    expect(v.state).toBe('valid')
    expect(v.remainingMs).toBe(90_000)
    expect(inviteExpiresAt(invite(NOW + 5))).toBe(NOW + 5)
    expect(inviteExpiresAt(null)).toBeNull()
  })
  it('formats the remaining time', () => {
    expect(formatRemaining(0)).toBe('expired')
    expect(formatRemaining(-5)).toBe('expired')
    expect(formatRemaining(45_000)).toBe('45 s')
    expect(formatRemaining(29 * 60_000 + 40_000)).toBe('29 min 40 s')
    expect(formatRemaining(60_000)).toBe('1 min 00 s')
  })
  it('syntax parsers reject other prefixes, bad rooms, bad signatures', () => {
    expect(parseInviteSyntax(invite())).toMatchObject({ room: ROOM, jti: JTI })
    expect(parseInviteSyntax(invite().replace('rvi1', 'rvx1'))).toBeNull()
    expect(parseInviteSyntax(`rvi1.rv-short.${JTI}.${NOW}.${SIG}`)).toBeNull()
    expect(parseInviteSyntax(`rvi1.${ROOM}.${JTI}.${NOW}.zz`)).toBeNull()
    expect(parseClaimSyntax(`rvc1.${ROOM}.partner-${'a'.repeat(12)}.${NOW}.${SIG}`)).toMatchObject({ identity: 'partner-' + 'a'.repeat(12) })
    expect(parseClaimSyntax(`rvc1.${ROOM}.owner-${'a'.repeat(12)}.${NOW}.${SIG}`)).toBeNull() // a claim can only name a partner identity
    expect(parseClaimSyntax(invite())).toBeNull()
  })
})

describe('TODO2: error mapping', () => {
  it('maps every join code to a plain-language message (no raw codes)', () => {
    for (const code of ['invite_invalid_or_expired', 'invite_used', 'claim_invalid_or_expired', 'session_ended', 'rate_limited', 'invite_store_unavailable', 'join_failed', 'livekit_not_configured', 'invalid_request', 'NotAllowedError', 'NotFoundError', 'network', 'something_else']) {
      const v = mapJoinError(code)
      expect(v.message.length, code).toBeGreaterThan(10)
      expect(v.message, code).not.toMatch(/_|http_|Could not join \(/)
    }
  })
  it('knows which errors are fatal (never offer Retry) and which are retryable', () => {
    expect(mapJoinError('invite_invalid_or_expired').fatal).toBe(true)
    expect(mapJoinError('session_ended', 410).fatal).toBe(true)
    expect(mapJoinError(undefined, 410).fatal).toBe(true)
    expect(mapJoinError('join_failed', 502).fatal).toBe(false)
    expect(mapJoinError('invite_store_unavailable', 503).fatal).toBe(false)
    expect(mapJoinError('rate_limited', 429).fatal).toBe(false)
    expect(mapJoinError('NotAllowedError').fatal).toBe(false)
    expect(mapJoinError('invite_used').message).toMatch(/reload/)
  })
})

describe('TODO2: claim-based rejoin store (partner phone)', () => {
  const mem = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
  }
  const claim = (exp: number, room = ROOM) => `rvc1.${room}.partner-${'a'.repeat(12)}.${exp}.${SIG}`
  it('round-trips, expires and clears', () => {
    const st = mem()
    writeStoredClaim(st, { claim: claim(NOW + 60_000), room: ROOM, label: 'Sam', at: NOW })
    expect(readStoredClaim(st, NOW)?.label).toBe('Sam')
    expect(readStoredClaim(st, NOW + 120_000)).toBeNull() // expired -> removed
    expect(readStoredClaim(st, NOW)).toBeNull()
    writeStoredClaim(st, { claim: claim(NOW + 60_000), room: ROOM, label: 'Sam', at: NOW })
    clearStoredClaim(st)
    expect(readStoredClaim(st, NOW)).toBeNull()
  })
  it('rejects a corrupt or mismatched stored value instead of throwing', () => {
    const st = mem()
    st.setItem('revoice.partner.claim', '{not json')
    expect(readStoredClaim(st, NOW)).toBeNull()
    writeStoredClaim(st, { claim: claim(NOW + 60_000, 'rv-' + 'd'.repeat(24)), room: ROOM, label: 'x', at: NOW })
    expect(readStoredClaim(st, NOW)).toBeNull()
    expect(readStoredClaim(undefined, NOW)).toBeNull()
  })
})

describe('TODO2: server join route (token before consume, claim rejoin)', () => {
  const LK_KEY = 'APIkey'
  const LK_SECRET = 'lk-secret-0123456789abcdef0123456789abcdef'
  beforeEach(() => {
    vi.stubEnv('LIVEKIT_URL', 'wss://example.livekit.cloud')
    vi.stubEnv('LIVEKIT_API_KEY', LK_KEY)
    vi.stubEnv('LIVEKIT_API_SECRET', LK_SECRET)
    vi.stubEnv('REVOICE_APPROVAL_SECRET', 'test-secret-0123456789abcdef0123456789')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('the route mints the token BEFORE it consumes the invite', () => {
    const src = read('src/app/api/livekit/join/route.ts')
    const mint = src.indexOf('await partnerToken({ room: inv.room')
    const consume = src.indexOf('await consumeInvite(')
    expect(mint).toBeGreaterThan(0)
    expect(consume).toBeGreaterThan(mint)
  })

  it('claims are signed, bound to room + identity + owner, and tamper-evident', async () => {
    const { signClaim, verifyClaim, claimExpiry } = await import('@/lib/server/livekit')
    const identity = 'partner-' + 'a1b2c3d4e5f6'
    const exp = claimExpiry({ startedAt: Date.now(), maxSessionMinutes: 20 })
    const c = await signClaim(ROOM, identity, 'owner-user', exp)
    expect(await verifyClaim(c, 'owner-user')).toMatchObject({ room: ROOM, identity })
    expect(await verifyClaim(c, 'someone-else')).toBeNull() // bound to the owner
    const parts = c.split('.')
    parts[2] = 'partner-' + 'ffffffffffff'
    expect(await verifyClaim(parts.join('.'), 'owner-user')).toBeNull() // identity swapped
    parts[2] = identity
    parts[4] = '0'.repeat(64)
    expect(await verifyClaim(parts.join('.'), 'owner-user')).toBeNull() // signature forged
    expect(await verifyClaim(c, 'owner-user', exp + 1)).toBeNull() // expired
  })

  it('claim lifetime is the room lifetime, never more than 30 minutes, never less than a minute', async () => {
    const { claimExpiry } = await import('@/lib/server/livekit')
    const t = NOW
    expect(claimExpiry({ startedAt: t, maxSessionMinutes: 20 }, t)).toBe(t + 21 * 60_000)
    expect(claimExpiry({ startedAt: t, maxSessionMinutes: 20 }, t + 19 * 60_000)).toBe(t + 21 * 60_000)
    expect(claimExpiry({ startedAt: t - 100 * 60_000, maxSessionMinutes: 20 }, t)).toBe(t + 60_000)
  })

  it('a re-join reuses the SAME partner identity; a forged identity is ignored', async () => {
    const { partnerToken } = await import('@/lib/server/livekit')
    const claims = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
    const a = await partnerToken({ room: ROOM, label: 'P', identity: 'partner-aaaaaaaaaaaa' })
    expect(a.identity).toBe('partner-aaaaaaaaaaaa')
    expect(claims(a.token).attributes.role).toBe('partner')
    const b = await partnerToken({ room: ROOM, label: 'P', identity: 'owner-xyz' })
    expect(b.identity).toMatch(/^partner-[a-f0-9]{12}$/)
    expect(b.identity).not.toBe('owner-xyz')
  })

  it('a partner token cannot be used to join another room or publish anything but a microphone', async () => {
    const { partnerToken } = await import('@/lib/server/livekit')
    const t = await partnerToken({ room: ROOM, label: 'P' })
    const c = JSON.parse(Buffer.from(t.token.split('.')[1], 'base64url').toString())
    expect(c.video.room).toBe(ROOM)
    expect(c.video.canPublishSources).toEqual(['microphone'])
    expect(c.video.roomAdmin).toBeFalsy()
    expect(c.video.roomCreate).toBeFalsy()
    void AccessToken
  })

  it('the join route accepts a claim OR an invite, never neither', () => {
    const src = read('src/app/api/livekit/join/route.ts')
    expect(src).toMatch(/invite_or_claim_required/)
    expect(src).toMatch(/claim_invalid_or_expired/)
  })
})

describe('TODO2: room timeouts', () => {
  it('partner modes give a partner time to arrive and a reloading phone time to come back', () => {
    expect(roomTimeouts('tabletop')).toEqual({ emptyTimeout: 120, departureTimeout: 30 })
    for (const m of ['partner-link', 'remote'] as const) {
      const t = roomTimeouts(m)
      expect(t.emptyTimeout).toBeGreaterThanOrEqual(300)
      expect(t.departureTimeout).toBeGreaterThanOrEqual(120)
    }
  })
  it('createRoomAndDispatch uses the mode-aware timeouts', () => {
    const src = read('src/lib/server/livekit.ts')
    expect(src).toMatch(/roomTimeouts\(meta\.mode\)/)
    expect(src).not.toMatch(/emptyTimeout: 120,\s*\n\s*departureTimeout: 30,/)
  })
})

describe('TODO3: mode-aware background / pagehide policy', () => {
  it('tabletop ends on pagehide after 3 minutes hidden; partner modes never end on pagehide and tolerate 10 minutes', () => {
    expect(backgroundPolicy('tabletop')).toEqual({ pagehideEnds: true, hiddenEndMs: 3 * 60_000 })
    expect(backgroundPolicy('partner-link')).toEqual({ pagehideEnds: false, hiddenEndMs: 10 * 60_000 })
    expect(backgroundPolicy('remote')).toEqual({ pagehideEnds: false, hiddenEndMs: 10 * 60_000 })
  })
  it('the app consults the policy on pagehide and ignores bfcache restores', () => {
    const app = read('src/components/ReVoiceApp.tsx')
    expect(app).toMatch(/backgroundPolicy\(s\.mode\)\.pagehideEnds/)
    expect(app).toMatch(/persisted\) return/)
  })
})

describe('TODO3: worker-absent behaviour by mode', () => {
  it('tabletop: direct listening when available, else end; partner modes NEVER end', () => {
    expect(workerAbsentAction('tabletop', true)).toBe('fallback_direct')
    expect(workerAbsentAction('tabletop', false)).toBe('end')
    expect(workerAbsentAction('partner-link', true)).toBe('relay')
    expect(workerAbsentAction('partner-link', false)).toBe('keep')
    expect(workerAbsentAction('remote', true)).toBe('relay')
    expect(workerAbsentAction('remote', false)).toBe('keep')
  })
  it('the 45 s auto-kill only applies to tabletop in the app', () => {
    const app = read('src/components/ReVoiceApp.tsx')
    expect(app).toMatch(/if \(s\.mode !== 'tabletop'\) return/)
    expect(app).not.toMatch(/the session ends automatically if it does not arrive/)
    expect(app).not.toMatch(/This session ends automatically if the worker does not arrive/)
  })
  it('relay runs only when NO worker transcribes, a partner is present, and browser STT is allowed', () => {
    const base = { mode: 'partner-link' as const, workerState: 'absent' as const, partnerPresent: true, browserStt: true }
    expect(relayDesired(base)).toBe(true)
    expect(relayDesired({ ...base, workerState: 'lost' })).toBe(true)
    for (const s of ['ready', 'waiting', 'connecting', 'degraded'] as const) expect(relayDesired({ ...base, workerState: s }), s).toBe(false) // never two paid streams
    expect(relayDesired({ ...base, partnerPresent: false })).toBe(false)
    expect(relayDesired({ ...base, browserStt: false })).toBe(false)
    expect(relayDesired({ ...base, mode: 'tabletop' })).toBe(false)
    expect(relayDesired({ ...base, workerState: null })).toBe(false)
  })
})

describe('TODO3: partner-phone relay protocol is locked down', () => {
  it('only an AssemblyAI streaming URL is accepted by the partner phone', () => {
    expect(isAssemblyStreamingUrl('wss://streaming.assemblyai.com/v3/ws?token=x&speech_model=universal-3-6-pro')).toBe(true)
    expect(isAssemblyStreamingUrl('wss://streaming.eu.assemblyai.com/v3/ws?token=x')).toBe(true)
    for (const u of ['wss://evil.example/v3/ws?token=x', 'ws://streaming.assemblyai.com/v3/ws?x', 'wss://streaming.assemblyai.com.evil.com/v3/ws?x', 'https://streaming.assemblyai.com/v3/ws?x', 'wss://streaming.assemblyai.com/other?x', '']) {
      expect(isAssemblyStreamingUrl(u), u).toBe(false)
    }
  })
  it('relay commands are accepted only from the owner; relay turns only from a partner (server-signed role attribute)', () => {
    expect(isOwnerPeer({ identity: 'o-abc', attributes: { role: 'owner' } })).toBe(true)
    expect(isOwnerPeer({ identity: 'partner-1', attributes: { role: 'partner' } })).toBe(false)
    expect(isOwnerPeer({ identity: 'agent-1', isAgent: true, attributes: { role: 'owner' } })).toBe(false)
    expect(isOwnerPeer({ identity: 'x' })).toBe(false)
    expect(isOwnerPeer(undefined)).toBe(false)
    expect(isPartnerPeer({ identity: 'partner-aaaaaaaaaaaa', attributes: { role: 'partner' } })).toBe(true)
    expect(isPartnerPeer({ identity: 'partner-aaaaaaaaaaaa', attributes: { role: 'owner' } })).toBe(false) // identity alone is not enough
    expect(isPartnerPeer({ identity: 'o-abc', attributes: { role: 'partner' } })).toBe(false)
    expect(isPartnerPeer({ identity: 'partner-aaaaaaaaaaaa', isAgent: true, attributes: { role: 'partner' } })).toBe(false)
    expect(isPartnerPeer(null)).toBe(false)
  })
  it('messages validate: bounded text, bounded turn ids, no unknown commands', () => {
    expect(RelayToPartner.safeParse({ type: 'relay', on: true, wsUrl: 'wss://streaming.assemblyai.com/v3/ws?a=1', maxSessionSeconds: 600 }).success).toBe(true)
    expect(RelayToPartner.safeParse({ type: 'relay', on: true, wsUrl: 'x', maxSessionSeconds: 99999 }).success).toBe(false)
    expect(RelayToPartner.safeParse({ type: 'relay', on: false }).success).toBe(true)
    expect(RelayToPartner.safeParse({ type: 'relay_gate', on: true, ttlMs: 500_000 }).success).toBe(false)
    expect(RelayToPartner.safeParse({ type: 'speak', text: 'hi' }).success).toBe(false) // a partner can never be told to "speak"
    expect(RelayFromPartner.safeParse({ type: 'relay_turn', turnId: 3, text: 'hello', endOfTurn: true }).success).toBe(true)
    expect(RelayFromPartner.safeParse({ type: 'relay_turn', turnId: 99999, text: 'hello', endOfTurn: true }).success).toBe(false)
    expect(RelayFromPartner.safeParse({ type: 'relay_turn', turnId: 1, text: 'x'.repeat(5000), endOfTurn: true }).success).toBe(false)
    expect(RelayFromPartner.safeParse({ type: 'speak', approval: {}, text: 'x' }).success).toBe(false) // relay carries text only, never an approval
  })
  it('relay turn ids from a restarted stream never overwrite older turns', () => {
    expect(RELAY_TURN_STRIDE).toBeGreaterThan(9999)
    expect(1 * RELAY_TURN_STRIDE + 0).toBeGreaterThan(0 * RELAY_TURN_STRIDE + 9999)
  })
  it('the owner listener only trusts relay turns from the ONE targeted partner while a relay is on', () => {
    const src = read('src/lib/client/listening.ts')
    expect(src).toMatch(/this\.relayOn && isPartnerPeer\(participant\) && participant\?\.identity === this\.relayTarget/)
    expect(src).toMatch(/relayTarget/)
  })
  it('relay text can never become speech: it feeds the same turn tracker, and speech still needs a server-signed approval', () => {
    const src = read('src/lib/client/listening.ts')
    expect(src).not.toMatch(/relay[\s\S]{0,200}speak\(/)
    const w = read('worker/revoice_worker/main.py')
    expect(w).toMatch(/accept_control_from/) // worker still only takes control from the owner identity
  })
  it('the relay URL is minted by the existing token route, so it is metered by the same ledger', () => {
    const app = read('src/components/ReVoiceApp.tsx')
    expect(app).toMatch(/api\.sttToken\(\{ sampleRate: 16000/)
    expect(app).toMatch(/await api\.endSession\(r\.session/)
  })
  it('data topic exists and the partner token may publish data (relay) while control stays owner-only', () => {
    expect(read('src/lib/contracts.ts')).toMatch(/relay: 'revoice\.relay'/)
    expect(read('src/lib/server/livekit.ts')).toMatch(/canPublishData: true/)
  })
})

describe('TODO3: owner-gone grace by mode (web mirrors worker)', () => {
  it('tabletop 30 s, partner-link / remote 120 s', () => {
    expect(OWNER_GONE_GRACE_S).toEqual({ tabletop: 30, 'partner-link': 120, remote: 120 })
    expect(ownerGoneGraceSeconds('partner-link')).toBe(120)
  })
  it('python worker config declares the same numbers', () => {
    const py = read('worker/revoice_worker/config.py')
    expect(py).toMatch(/OWNER_GONE_GRACE_BY_MODE = \{"tabletop": 30, "partner-link": 120, "remote": 120\}/)
  })
})

describe('hygiene: env example and deployment files', () => {
  it('.env.example is clean and complete; env.example duplicate is gone', () => {
    const e = read('.env.example')
    expect(e).not.toMatch(/NEXT_PUBLIC_SUPABASE|ANON_KEY|OAUTH|GITHUB|GOOGLE/i)
    expect(e).toMatch(/REVOICE_ALLOW_BROWSER_STT=true/)
    for (const k of ['ASSEMBLYAI_API_KEY=', 'GROQ_API_KEY=', 'LIVEKIT_URL=', 'LIVEKIT_API_KEY=', 'LIVEKIT_API_SECRET=', 'REVOICE_APPROVAL_SECRET=', 'CRON_SECRET=']) expect(e).toContain(k)
    expect(e).not.toMatch(/=\s*[A-Za-z0-9]{20,}\s*$/m) // no real-looking values committed
    expect(fs.existsSync(path.join(root, 'env.example'))).toBe(false)
  })
  it('vercel.json: Next.js preset, no Cloudflare/Hono, cron + security headers; .vercelignore keeps worker/tests out of the upload', () => {
    const v = JSON.parse(read('vercel.json'))
    expect(v.framework).toBe('nextjs')
    expect(JSON.stringify(v)).not.toMatch(/cloudflare|wrangler|hono/i)
    expect(v.crons?.[0]?.path).toBe('/api/cron/purge')
    const ig = read('.vercelignore')
    expect(ig).toMatch(/^worker\/$/m)
    expect(ig).toMatch(/^tests\/$/m)
    expect(ig).toMatch(/^\.env$/m)
  })
  it('no Cloudflare / Hono code anywhere in the source or dependencies', () => {
    const pkg = read('package.json')
    expect(pkg).not.toMatch(/hono|wrangler|cloudflare/i)
    expect(fs.existsSync(path.join(root, 'wrangler.jsonc'))).toBe(false)
  })
  it('no sign-in surface was reintroduced', () => {
    for (const f of ['src/app/join/page.tsx', 'src/components/ReVoiceApp.tsx']) expect(read(f)).not.toMatch(/\bsign in\b|signIn\(|supabase\.auth/i)
  })
})

describe('regression found by the local-LiveKit e2e: the session route returns the invite STRING', () => {
  it('returns invite as a string (not the {invite,jti,exp} object) and the expiry separately', () => {
    const src = read('src/app/api/livekit/session/route.ts')
    expect(src).toMatch(/invite: invite\?\.invite \?\? null/)
    expect(src).toMatch(/inviteExpiresAt: invite\?\.exp \?\? null/)
    expect(src).not.toMatch(/conversationId, invite, ticket/)
  })
  it('the client never crashes on a non-string invite', () => {
    expect(inviteExpiresAt({ invite: 'x' } as unknown as string)).toBeNull()
    expect(inviteInfo({ invite: 'x' } as unknown as string).state).toBe('malformed')
  })
})
