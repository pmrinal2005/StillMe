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
 * B19 — a REAL account deletion.
 *
 * Bug: /api/account/delete only called forgetUser() (this instance's memory) and cleared a cookie. The Supabase auth
 * user, its rows, its open listening rooms (still billing STT), its open spend reservations and its cloned voices all
 * survived — the UI said "deleted" while the account kept working. Order matters, most dangerous first:
 *   1. tombstone cloned voices   (a clone stops being usable even if a later step fails; nobody can re-claim its id)
 *   2. close every live room     (ends the worker, stops STT billing) and settle the room's reservation
 *   3. settle open reservations  (committed conservatively — never refunded: the provider may already have billed)
 *   4. delete user-owned rows
 *   5. delete the auth user      (LAST: until it succeeds the user can still sign in and retry)
 * Each step is reported; a failed step never silently passes (`ok:false` + the step list).
 */
export interface DeleteStep {
  step: string
  ok: boolean
  detail?: string
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

/** Tables holding rows for the user (client-owned + server-written). budget_reservations is deliberately NOT here. */
export const USER_TABLES = [
  'phrases', 'phrase_boards', 'style_cards', 'accessibility_prefs', 'biometric_consents', 'voice_profiles',
  'session_members', 'conversation_sessions', 'usage_events', 'audit_events', 'approval_uses', 'phone_calls', 'phone_pair_codes', 'profiles',
] as const

export async function deleteAccount(id: Identity): Promise<{ ok: boolean; steps: DeleteStep[]; voiceIds: string[] }> {
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
  const real = id.kind === 'supabase' && isUuid(id.userId)

  // 1. voices
  let voiceIds: string[] = []
  voiceIds = (await run('tombstone_voices', async () => {
    const store = real ? supabaseVoiceStore() ?? memoryVoiceStore() : memoryVoiceStore()
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

  // 3 + 4 + 5 need the durable store and a real account.
  if (sb && real) {
    await run('settle_reservations', async () => {
      const { error } = await sb.rpc('settle_open_reservations', { p_subject: id.userId })
      if (error && !/could not find the function|settle_open_reservations/i.test(error.message)) throw new Error(error.code ?? 'rpc_failed')
    })
    await run('delete_rows', async () => {
      for (const t of USER_TABLES) {
        const { error } = await sb.from(t).delete().eq(t === 'profiles' ? 'user_id' : 'user_id', id.userId)
        // A table that does not exist on this deployment (migration not applied) is not a failure.
        if (error && !(error.code === '42P01' || error.code === 'PGRST205')) throw new Error(`${t}:${error.code ?? 'failed'}`)
      }
    })
  }
  // Supabase auth user: a real account, or the user behind an ANONYMOUS guest session.
  const authUser = real ? id.userId : id.anonymous && id.authUserId && isUuid(id.authUserId) ? id.authUserId : null
  if (sb && authUser) {
    await run('delete_auth_user', async () => {
      const { error } = await sb.auth.admin.deleteUser(authUser)
      if (error && !/not.?found/i.test(error.message)) throw new Error(error.status ? String(error.status) : 'delete_failed')
    })
  }

  forgetUser(id.userId)
  return { ok: steps.every((s) => s.ok), steps, voiceIds }
}

/** Server-side data export for the signed-in user (content-free server tables + the voice registry). */
export const EXPORT_TABLES = [
  'profiles', 'accessibility_prefs', 'style_cards', 'voice_profiles', 'biometric_consents', 'phrase_boards', 'phrases',
  'conversation_sessions', 'session_members', 'usage_events', 'audit_events', 'phone_calls',
] as const

export async function exportAccountData(id: Identity): Promise<Record<string, unknown>> {
  const sb = adminClient()
  const out: Record<string, unknown> = {}
  if (!sb || !isUuid(id.userId) || id.kind !== 'supabase') return out
  for (const t of EXPORT_TABLES) {
    const { data, error } = await sb.from(t).select('*').eq('user_id', id.userId).limit(5000)
    out[t] = error ? { unavailable: error.code ?? 'error' } : data
  }
  // Spend history is accounting for the project's provider credit; the user's own rows are exported content-free.
  const { data: spend, error: se } = await sb.from('budget_reservations').select('provider, day, units, actual_units, status, created_at').eq('user_id', id.userId).limit(5000)
  out.budget_reservations = se ? { unavailable: se.code ?? 'error' } : spend
  return out
}
