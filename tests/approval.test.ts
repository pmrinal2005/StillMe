import { describe, expect, it } from 'vitest'
import { APPROVAL_TTL_MS, ApprovalError, MemoryReplayStore, canonicalApprovalString, issueApproval, verifyApproval } from '@/lib/approval'
import { hmacSha256Hex, sha256Hex } from '@/lib/hash'
import { OWNER, ROOM, SECRET, approveReq, signed } from './helpers'

const expect_ = { sub: OWNER, conversationId: 'conv1', roomName: ROOM, generation: 0, voiceId: 'aai-audrey' }

async function reason(p: Promise<unknown>) {
  try {
    await p
    return 'accepted'
  } catch (e) {
    return e instanceof ApprovalError ? e.reason : String(e)
  }
}

describe('approval protocol', () => {
  it('accepts the exact approved text once', async () => {
    const a = await signed('Yes, Tuesday works.')
    const replay = new MemoryReplayStore()
    await expect(verifyApproval({ secret: SECRET, approval: a, text: 'Yes, Tuesday works.', expect: expect_, replay })).resolves.toMatchObject({ approvalId: a.approvalId })
  })

  it('refuses to issue when displayed text differs from the hash', async () => {
    const req = await approveReq('I agree.')
    req.text = 'I do not agree.'
    expect(await reason(issueApproval({ secret: SECRET, sub: OWNER, req }))).toBe('altered_text')
  })

  it('rejects altered, replayed, expired, wrong-user, wrong-room, stale-generation, wrong-voice and forged approvals', async () => {
    const now = Date.now()
    const a = await signed('Hello there', { now })
    const r = () => new MemoryReplayStore()
    const v = (over: Partial<typeof a> = {}, text = 'Hello there', exp = expect_, at = now) =>
      reason(verifyApproval({ secret: SECRET, approval: { ...a, ...over }, text, expect: exp, replay: r(), now: at }))

    expect(await v({}, 'Hello there!')).toBe('altered_text')
    expect(await v({}, 'Hello there', expect_, now + APPROVAL_TTL_MS + 1)).toBe('expired')
    expect(await v({}, 'Hello there', { ...expect_, sub: 'someone-else' })).toBe('wrong_user')
    expect(await v({}, 'Hello there', { ...expect_, roomName: 'rv-other' })).toBe('wrong_room')
    expect(await v({}, 'Hello there', { ...expect_, conversationId: 'conv2' })).toBe('wrong_room')
    expect(await v({}, 'Hello there', { ...expect_, generation: 1 })).toBe('stale_generation')
    expect(await v({}, 'Hello there', { ...expect_, voiceId: 'aai-peter' })).toBe('wrong_voice')
    // Tampering with any signed field breaks the signature.
    expect(await v({ voiceId: 'aai-peter' })).toBe('bad_signature')
    expect(await v({ exp: a.exp + 3_600_000 })).toBe('bad_signature')
    expect(await v({ sub: 'attacker' })).toBe('bad_signature')
    // Signed with another secret
    const forged = await hmacSha256Hex('wrong-secret', canonicalApprovalString({ ...a }))
    expect(await v({ sig: forged })).toBe('bad_signature')

    const replay = new MemoryReplayStore()
    await verifyApproval({ secret: SECRET, approval: a, text: 'Hello there', expect: expect_, replay, now })
    expect(await reason(verifyApproval({ secret: SECRET, approval: a, text: 'Hello there', expect: expect_, replay, now }))).toBe('replayed')
  })

  it('does not burn an approval that fails an earlier check', async () => {
    const a = await signed('Okay')
    const replay = new MemoryReplayStore()
    expect(await reason(verifyApproval({ secret: SECRET, approval: a, text: 'Okay', expect: { ...expect_, sub: 'x' }, replay }))).toBe('wrong_user')
    expect(await reason(verifyApproval({ secret: SECRET, approval: a, text: 'Okay', expect: expect_, replay }))).toBe('accepted')
  })

  it('binds AI candidates to the turn revision they answered (stale candidate)', async () => {
    const h = await sha256Hex('Shall we meet Tuesday?')
    const turn = { conversationId: 'conv1', generation: 0, turnId: 3, revision: 1, transcriptHash: h }
    const req = await approveReq('Tuesday is fine.', { source: { candidateSetId: 's1', candidateId: 'c1', turn, edited: false } })
    await expect(issueApproval({ secret: SECRET, sub: OWNER, req, candidate: { currentTurn: turn } })).resolves.toBeTruthy()
    const moved = { ...turn, revision: 2, transcriptHash: await sha256Hex('Shall we meet Tuesday? Actually not Tuesday.') }
    expect(await reason(issueApproval({ secret: SECRET, sub: OWNER, req, candidate: { currentTurn: moved } }))).toBe('stale_candidate')
  })

  it('NFC-normalizes text so composed/decomposed forms hash identically', async () => {
    const composed = 'Café'
    const decomposed = 'Cafe\u0301'
    expect(await sha256Hex(composed)).toBe(await sha256Hex(decomposed))
    const a = await signed(composed)
    expect(a.chars).toBe(4)
  })

  it('canonical string matches the Python worker format', async () => {
    const a = await signed('x', { now: 1000 })
    const lines = canonicalApprovalString(a).split('\n')
    expect(lines.map((l) => l.split('=')[0])).toEqual(['v', 'approvalId', 'playbackAttemptId', 'sub', 'conversationId', 'roomName', 'generation', 'textHash', 'voiceId', 'outputLanguage', 'chars', 'iat', 'exp'])
  })
})
