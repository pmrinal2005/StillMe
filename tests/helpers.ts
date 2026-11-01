import { issueApproval } from '@/lib/approval'
import type { ApproveRequest } from '@/lib/contracts'
import { sha256Hex } from '@/lib/hash'

export const SECRET = 'test-secret-0123456789abcdef0123456789'
export const OWNER = 'user-1'
export const ROOM = 'rv-aaaaaaaaaaaaaaaaaaaaaaaa'

export async function approveReq(text: string, over: Partial<ApproveRequest> = {}): Promise<ApproveRequest> {
  return {
    text,
    textHash: await sha256Hex(text),
    conversationId: 'conv1',
    roomName: ROOM,
    generation: 0,
    voiceId: 'aai-audrey',
    outputLanguage: 'english',
    ...over,
  }
}

export async function signed(text: string, opts: { now?: number; sub?: string; over?: Partial<ApproveRequest> } = {}) {
  return issueApproval({ secret: SECRET, sub: opts.sub ?? OWNER, req: await approveReq(text, opts.over), now: opts.now })
}
