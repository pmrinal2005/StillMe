import { z } from 'zod'
import { json } from '@/lib/server/auth'
import { env } from '@/lib/server/env'
import { claimExpiry, evictStalePartners, getRoomMeta, parseInvite, partnerToken, signClaim, verifyClaim, verifyInvite } from '@/lib/server/livekit'
import { consumeInvite } from '@/lib/server/invites'
import { allow } from '@/lib/server/rate-limit'
import { clientIp } from '@/lib/server/spend'
import { logEvent } from '@/lib/server/log'
import { withJsonErrors } from '@/lib/server/route'
import { sessionMemberJoin } from '@/lib/server/ops-db'
import { parseClaimSyntax } from '@/lib/invite-link'

export const dynamic = 'force-dynamic'

const Body = z
  .object({
    invite: z.string().max(400).optional(),
    /** Re-join with the claim issued when the invite was consumed (same phone: reload, lock screen, network change). */
    claim: z.string().max(400).optional(),
    label: z.string().max(40).default('Partner'),
    consent: z.literal(true),
  })
  .refine((b) => !!b.invite || !!b.claim, { message: 'invite_or_claim_required' })

/**
 * Partner joins via an expiring, SINGLE-USE signed invite and must acknowledge transcription disclosure.
 *
 * B17: the link carries no user id. The owner is recovered from the SEALED room metadata (server-set at creation) and
 * bound into the invite signature, so a forged/edited invite fails; the invite id is then consumed atomically, so a
 * second use (any instance) is refused. The owner mints a fresh link per additional partner (/api/livekit/invite).
 *
 * TODO2 (this release):
 *  - TOKEN BEFORE CONSUME: the LiveKit token (and claim) are minted BEFORE the invite is burned. Previously a token failure
 *    (or any error after consumption) burned the link and the partner could never retry.
 *  - CLAIM-BASED REJOIN: a successful join returns a signed claim. The same phone presents it to get a new token for the SAME
 *    partner identity (no invite consumed), so a reload / lock screen / network change no longer locks the partner out.
 *  - Errors are mapped to stable codes the join page turns into plain language (src/lib/join-errors.ts).
 */
async function handlePOST(req: Request) {
  if (!env.livekitUrl() || !env.livekitKey() || !env.livekitSecret()) return json({ error: 'livekit_not_configured' }, 503)
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_request', message: 'Consent to transcription is required to join.' }, 400)
  // Cheap per-instance brake against invite guessing / hammering from one address.
  if (!allow(`join:${clientIp(req) ?? 'unknown'}`, 20, 10 * 60_000)) return json({ error: 'rate_limited', message: 'Too many attempts. Please wait a few minutes.' }, 429)
  const b = parsed.data
  try {
    // ------------------------------------------------------------------ claim-based rejoin (no invite consumed)
    if (b.claim && !b.invite) {
      const c = parseClaimSyntax(b.claim)
      if (!c || Date.now() > c.exp) return json({ error: 'claim_invalid_or_expired' }, 403)
      const meta = await getRoomMeta(c.room)
      if (!meta) return json({ error: 'session_ended', message: 'This conversation has ended.' }, 410)
      if (meta.mode === 'tabletop') return json({ error: 'claim_invalid_or_expired' }, 403)
      const v = await verifyClaim(b.claim, meta.ownerIdentity)
      if (!v) return json({ error: 'claim_invalid_or_expired' }, 403)
      const { token, identity } = await partnerToken({ room: v.room, label: b.label, identity: v.identity })
      const exp = claimExpiry(meta)
      const claim = await signClaim(v.room, identity, meta.ownerIdentity, exp)
      logEvent({ evt: 'partner_join', status: 'ok', room: v.room, kind: 'rejoin' })
      return json({ url: env.livekitUrl(), token, identity, room: v.room, claim, claimExpiresAt: exp })
    }

    // ------------------------------------------------------------------ first join with an invite
    const p = parseInvite(b.invite ?? '')
    if (!p) return json({ error: 'invite_invalid_or_expired' }, 403)
    if (Date.now() > p.exp) return json({ error: 'invite_invalid_or_expired' }, 403)
    // The room (and therefore the owner) must still exist. Lookup errors fail CLOSED (we need the owner to verify).
    const meta = await getRoomMeta(p.room)
    if (!meta) return json({ error: 'session_ended', message: 'This conversation has ended.' }, 410)
    if (meta.mode === 'tabletop') return json({ error: 'invite_invalid_or_expired' }, 403)
    const inv = await verifyInvite(b.invite ?? '', meta.ownerIdentity)
    if (!inv) return json({ error: 'invite_invalid_or_expired' }, 403)

    // TOKEN BEFORE CONSUME. B1: partnerToken passes TrackSource.MICROPHONE (enum) so toJwt() does not throw. If minting throws,
    // the invite is still unused and the partner can simply retry.
    const { token, identity } = await partnerToken({ room: inv.room, label: b.label })
    const exp = claimExpiry(meta)
    const claim = await signClaim(inv.room, identity, meta.ownerIdentity, exp)

    const used = await consumeInvite(inv.jti, inv.room, inv.exp)
    if (used === 'used') return json({ error: 'invite_used', message: 'This link was already used. Ask for a new one.' }, 403)
    if (used === 'unavailable') return json({ error: 'invite_store_unavailable', message: 'Could not verify this link right now. Please try again.' }, 503)

    // E51: a partner whose phone reloaded still has a ghost participant for ~15 s. Evict the stalest partner(s) so the person
    // actually re-joining is never locked out by their own previous connection ("room full"). Never fails the join.
    const evicted = await evictStalePartners(inv.room).catch(() => 0)
    void sessionMemberJoin(inv.room, identity, 'partner') // E48: durable session_members row (identity only)
    logEvent({ evt: 'partner_join', status: 'ok', room: inv.room, evicted: evicted || undefined })
    return json({ url: env.livekitUrl(), token, identity, room: inv.room, claim, claimExpiresAt: exp })
  } catch (e) {
    logEvent({ evt: 'partner_join', status: 'error', detail: (e as Error).message?.slice(0, 120) })
    return json({ error: 'join_failed', message: 'Could not join right now. Please try again.' }, 502)
  }
}

export const POST = withJsonErrors('livekit/join', handlePOST)
