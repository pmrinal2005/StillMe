import { z } from 'zod'
import { cookies } from 'next/headers'
import { DEVICE_COOKIE, getIdentity, json } from '@/lib/server/auth'
import { deleteDeviceData } from '@/lib/server/account'
import { allow } from '@/lib/server/rate-limit'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

const Body = z.object({ confirm: z.literal('DELETE MY DATA') })

/**
 * Delete THIS DEVICE'S data on the server — cloned voices tombstoned, live rooms closed (STT billing stops), open
 * reservations settled, device-owned rows removed. There is no account to delete. Requires an explicit typed
 * confirmation in the body (a stray POST cannot delete anything). Data held by third parties (AssemblyAI clones, Groq
 * retention, LiveKit) is listed in `thirdPartyActions`.
 */
async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!Body.safeParse(await req.json().catch(() => null)).success) return json({ error: 'confirmation_required', message: 'Send {"confirm":"DELETE MY DATA"} to delete this device’s data.' }, 400)
  if (!allow(`delete:${id.userId}`, 3, 60 * 60_000)) return json({ error: 'rate_limited' }, 429)
  const r = await deleteDeviceData(id)
  // The device identity is a cookie. Drop it only when every server step succeeded, so a partial failure can be retried
  // with the SAME identity (the failed step report says which one).
  if (r.ok) (await cookies()).delete(DEVICE_COOKIE)
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

export const POST = withJsonErrors('data/delete', handlePOST)
