import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { providerStatus } from '@/lib/server/env'
import { ledgerFor, projectLedger } from '@/lib/server/state'
import { LIMITS } from '@/lib/budget'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

async function handleGET(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  return json({
    identity: { userId: id.userId, kind: id.kind },
    providers: providerStatus(),
    budget: { user: ledgerFor(id.userId).snapshot(), project: projectLedger().snapshot(), limits: LIMITS },
  })
}

export const GET = withJsonErrors('status', handleGET)
