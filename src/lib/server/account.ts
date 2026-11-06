import 'server-only'
import { adminClient } from './durable'
import { deleteRoom, listOwnerRooms } from './livekit'
import { env } from './env'
import { forgetUser, settleLocalStt } from './state'
import { settleByRef } from './spend'
import { memoryVoiceStore, supabaseVoiceStore } from './voice-registry'
import { sttMinutesToCommit } from '../spend-refs'
import type { Identity } from './auth'

/**
 * Delete THIS DEVICE'S server-side data (there are no accounts). Order matters, most dangerous first:
 *   1. tombstone cloned voices   (a clone stops being usable even if a later step fails; nobody can re-claim its id)
 *   2. close every live room     (ends the worker, stops STT billing) and settle the room's reservation
 *   3. settle open reservations  (committed conservatively — never refunded: the provider may already have billed)
 *   4. delete device-owned rows
 * Each step is reported; a failed step never silently passes (`ok:false` + the step list).
 */
export interface DeleteStep {
  step: string
  ok: boolean
  detail?: string
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

/** Tables holding rows for the user (client-owned + server-written). budget_reservations is deliberately NOT here. */
// voice_profiles BEFORE biometric_consents: the append-only trigger (0005) refuses to delete a consent row while its voice
// profile still exists, but allows the cascade that follows deleting the profile.
export const USER_TABLES = [
  'phrases', 'phrase_boards', 'style_cards', 'accessibility_prefs', 'voice_profiles', 'biometric_consents',
  'session_members', 'conversation_sessions', 'usage_events', 'audit_events', 'approval_uses', 'phone_calls', 'phone_pair_codes', 'profiles',
] as const

export async function deleteDeviceData(id: Identity): Promise<{ ok: boolean; steps: DeleteStep[]; voiceIds: string[] }> {
  const steps: DeleteStep[] = []
  const run = async <T>(step: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      const r = await fn()
      steps.push({ step, ok: true })
      return r
    } catch (e) {
      steps.push({ step, ok: false, detail: (e as Error).message?.slice(0, 100) })
      return undefined
    }
  }
  const sb = adminClient()
  const durable = isUuid(id.userId)

  // 1. voices
  let voiceIds: string[] = []
  voiceIds = (await run('tombstone_voices', async () => {
    const store = durable ? supabaseVoiceStore() ?? memoryVoiceStore() : memoryVoiceStore()
    return store.tombstoneAll(id.userId)
  })) ?? []

  // 2. rooms
  if (env.livekitUrl() && env.livekitKey() && env.livekitSecret()) {
    await run('close_rooms', async () => {
      for (const { room, meta } of await listOwnerRooms(id.userId)) {
        await deleteRoom(room)
        const used = sttMinutesToCommit({ reserved: meta.sttMinutes ?? meta.maxSessionMinutes, startedAt: meta.startedAt ?? Date.now() })
        settleLocalStt(id.userId, room, used)
        await settleByRef(room, 'assemblyai_stt', true, used, false)
      }
    })
  }

  // 3 + 4 need the durable store.
  if (sb && durable) {
    await run('settle_reservations', async () => {
      const { error } = await sb.rpc('settle_open_reservations', { p_subject: id.userId })
      if (error && !/could not find the function|settle_open_reservations/i.test(error.message)) throw new Error(error.code ?? 'rpc_failed')
    })
    await run('delete_rows', async () => {
      for (const t of USER_TABLES) {
        const { error } = await sb.from(t).delete().eq('user_id', id.userId)
        // A table that does not exist on this deployment (migration not applied) is not a failure.
        if (error && !(error.code === '42P01' || error.code === 'PGRST205')) throw new Error(`${t}:${error.code ?? 'failed'}`)
      }
    })
  }
  forgetUser(id.userId)
  return { ok: steps.every((s) => s.ok), steps, voiceIds }
}

/** Server-side data export for this device (content-free server tables + the voice registry). */
export const EXPORT_TABLES = [
  'profiles', 'accessibility_prefs', 'style_cards', 'voice_profiles', 'biometric_consents', 'phrase_boards', 'phrases',
  'conversation_sessions', 'session_members', 'usage_events', 'audit_events', 'phone_calls',
] as const

export async function exportDeviceData(id: Identity): Promise<Record<string, unknown>> {
  const sb = adminClient()
  const out: Record<string, unknown> = {}
  if (!sb || !isUuid(id.userId)) return out
  for (const t of EXPORT_TABLES) {
    const { data, error } = await sb.from(t).select('*').eq('user_id', id.userId).limit(5000)
    out[t] = error ? { unavailable: error.code ?? 'error' } : data
  }
  // Spend history is accounting for the project's provider credit; the user's own rows are exported content-free.
  const { data: spend, error: se } = await sb.from('budget_reservations').select('provider, day, units, actual_units, status, created_at').eq('user_id', id.userId).limit(5000)
  out.budget_reservations = se ? { unavailable: se.code ?? 'error' } : spend
  return out
}
