import { z } from 'zod'
import { cookies } from 'next/headers'
import { DEVICE_COOKIE, deviceCookieOptions, deviceKeyFor, getIdentity, json, parseDeviceKey } from '@/lib/server/auth'
import { allow } from '@/lib/server/rate-limit'
import { withJsonErrors } from '@/lib/server/route'

export const dynamic = 'force-dynamic'

/**
 * Device key backup / restore. There are no accounts, so this device's identity IS its signed cookie. A cloned voice is
 * bound to that identity, so clearing cookies would orphan it. The user can therefore copy their DEVICE KEY (a signed
 * random id, not a password and not tied to any person) and paste it into another browser, or back into this one after
 * clearing data, to keep the same identity. Treat it like a bearer secret: anyone holding it acts as this device.
 *
 *  GET  → { key }                      the current device key
 *  POST → { key } restores that identity (signature verified; a forged key is refused)
 */
async function handleGET(req: Request) {
  const id = await getIdentity(req)
  return json({ key: await deviceKeyFor(id.deviceId) })
}

const Body = z.object({ key: z.string().min(40).max(200) })

async function handlePOST(req: Request) {
  const id = await getIdentity(req)
  if (!allow(`device-restore:${id.userId}`, 10, 10 * 60_000)) return json({ error: 'rate_limited' }, 429)
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return json({ error: 'invalid_key', message: 'That is not a valid device key.' }, 400)
  const deviceId = await parseDeviceKey(parsed.data.key)
  if (!deviceId) return json({ error: 'invalid_key', message: 'That device key is not valid for this server.' }, 400)
  ;(await cookies()).set(DEVICE_COOKIE, await deviceKeyFor(deviceId), deviceCookieOptions())
  return json({ ok: true })
}

export const GET = withJsonErrors('device', handleGET)
export const POST = withJsonErrors('device', handlePOST)
