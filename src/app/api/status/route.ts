import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { providerStatus } from '@/lib/server/env'
import { ledgerFor, projectLedger } from '@/lib/server/state'
import { LIMITS } from '@/lib/budget'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  return json({
    identity: { userId: id.userId, kind: id.kind },
    providers: providerStatus(),
    budget: { user: ledgerFor(id.userId).snapshot(), project: projectLedger().snapshot(), limits: LIMITS },
  })
}
