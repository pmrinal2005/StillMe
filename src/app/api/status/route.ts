import { getIdentity, isOperator, json } from '@/lib/server/auth'
import { env, providerStatus } from '@/lib/server/env'
import { ledgerFor, projectLedger } from '@/lib/server/state'
import { LIMITS } from '@/lib/budget'
import { spendStoreStatus } from '@/lib/server/spend'
import { userMeters, type PublicStatus } from '@/lib/status-view'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

/**
 * B18: MINIMAL public status. The caller's identity KIND (never the user id), feature flags, region, the caller's own
 * daily meters and the session-length cap — what the UI needs and nothing more. Project-wide spend, lifetime/spendable
 * credit, caps, spend-store mode, the approval-secret source and the Groq model are returned ONLY to an operator
 * (fail-closed allowlist) under `operator`.
 */
async function handleGET(req: Request) {
  const id = await getIdentity(req)
  const operator = await isOperator(req)
  const p = providerStatus()
  const body: PublicStatus = {
    providers: {
      assemblyai: p.assemblyai,
      groq: p.groq,
      livekit: p.livekit,
      durableStore: p.durableStore,
      browserStt: p.browserStt,
      phoneInbound: p.phoneInbound,
      approvalSecretConfigured: p.approvalSecretConfigured,
      region: p.region,
    },
    budget: {
      user: userMeters(ledgerFor(id.userId).snapshot()),
      limits: { assembly: { interactiveSessionMinutes: LIMITS.assembly.interactiveSessionMinutes }, livekit: { monthlyInboundPhoneMinutes: LIMITS.livekit.monthlyInboundPhoneMinutes } },
    },
  }
  if (operator) {
    body.operator = {
      userId: id.userId,
      providers: { approvalSecretSource: p.approvalSecretSource, groqModel: p.groqModel, region: env.assemblyRegion() },
      spendStore: await spendStoreStatus(),
      budget: { user: ledgerFor(id.userId).snapshot(), project: projectLedger().snapshot(), limits: LIMITS },
    }
  }
  return json(body)
}

export const GET = withJsonErrors('status', handleGET)
