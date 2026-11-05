import { z } from 'zod'
import { cookies } from 'next/headers'
import { getIdentity, json, unauthorized } from '@/lib/server/auth'
import { deleteAccount } from '@/lib/server/account'
import { allow } from '@/lib/server/rate-limit'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

const Body = z.object({ confirm: z.literal('DELETE MY ACCOUNT') })

/**
 * B19: REAL deletion — cloned voices tombstoned, live rooms closed (STT billing stops), open reservations settled,
 * user rows removed and the Supabase auth user deleted. Requires an explicit typed confirmation in the request body
 * (a stray POST or a CSRF-style call cannot delete an account). Application deletion does NOT delete data held by
 * third parties: AssemblyAI clones, Groq retention and LiveKit are listed in `thirdPartyActions`.
 */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!id) return unauthorized()
  if (!Body.safeParse(await req.json().catch(() => null)).success) return json({ error: 'confirmation_required', message: 'Send {"confirm":"DELETE MY ACCOUNT"} to delete this account.' }, 400)
  if (!allow(`delete:${id.userId}`, 3, 60 * 60_000)) return json({ error: 'rate_limited' }, 429)
  const r = await deleteAccount(id)
  // Device identities are cookies: drop them whatever else happened. A failed server step keeps the real account
  // signed in on the client so the user can retry (the response says which step failed).
  const jar = await cookies()
  if (id.kind === 'local-demo') jar.delete('rv_demo')
  if (id.kind === 'guest') jar.delete('rv_guest')
  return json(
    {
      ok: r.ok,
      steps: r.steps,
      voicesTombstoned: r.voiceIds.length,
      thirdPartyActions: [
        'Delete any cloned voice in the AssemblyAI dashboard (Text-to-speech → Voices). ReVOICE has made those voices unusable here, but AssemblyAI still holds them.',
        'Groq: verify Zero Data Retention settings; exception logs may be kept up to 30 days.',
        'LiveKit: rooms are ephemeral; no recordings are made by ReVOICE.',
      ],
    },
    r.ok ? 200 : 502,
  )
}

export const POST = withJsonErrors('account/delete', handlePOST)
