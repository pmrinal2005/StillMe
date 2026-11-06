-- 0005: E-series (database and infrastructure) + F-series (missing vs. the ReVOICE plan).
--
--  E47  ONE global budget lock. reserve_budget (0001: lock per provider+day) and reserve_budget_v3 (0003: lock per day)
--       took different advisory locks, yet both enforce the SHARED AssemblyAI dollar limits (TTS + STT) and the lifetime
--       protected reserve. Two concurrent requests (one speech, one listening; or one legacy, one v3) could both pass.
--       Every function that reads or changes budget state now takes the same lock first. The legacy user-USD check also
--       only summed ONE provider; it now sums all AssemblyAI providers like v3 does.
--  E49  purge_all_metadata() + an optional pg_cron schedule (the web app also calls it from /api/cron/purge).
--       Scheduling the purge exposed a latent bug: purge_old_metadata() deleted budget_reservations older than 90 days,
--       and the LIFETIME protected-reserve check sums that table, so purging silently re-opened the $15 reserve.
--       Purged spend is now rolled up into budget_rollup, which the lifetime check includes.
--  E48  Tables that were created but never used are now wired: phrase boards/phrases (soft-delete + updated_at for
--       two-way sync), conversation sessions/members (written by the server), pair codes (atomic attempt counter).
--  F    room_budget_status (re-check a running room), usage_variance (estimate vs actual), append-only consent history.
-- Content-free: no text, audio or transcripts.

-- ================================================================================================ E47: one lock
create or replace function public.budget_lock() returns void
language sql as $$ select pg_advisory_xact_lock(hashtextextended('revoice:budget:global', 0)) $$;

create table if not exists public.budget_rollup (
  provider text primary key,
  units numeric not null default 0,
  usd numeric not null default 0,
  rows_purged bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.budget_rollup enable row level security;
alter table public.budget_rollup force row level security; -- service role only

-- STT profile is recorded for variance reporting; units stay REAL minutes (est_usd carries the profile's rate).
alter table public.budget_reservations add column if not exists stt_profile text check (stt_profile is null or stt_profile in ('flagship','economy'));

-- Legacy reservation (0001 signature). Same lock as v3; user USD now spans every AssemblyAI provider.
create or replace function public.reserve_budget(
  p_user uuid, p_provider text, p_units numeric, p_est_usd numeric,
  p_user_daily_units numeric, p_project_daily_units numeric,
  p_user_daily_usd numeric, p_project_daily_usd numeric,
  p_lifetime_spendable_usd numeric
) returns table (ok boolean, reason text, reservation_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  u_units numeric; p_units_used numeric; u_usd numeric; p_usd numeric; life_usd numeric;
  v_id uuid;
begin
  perform public.budget_lock();
  select coalesce(sum(coalesce(actual_units, units)), 0) into u_units from budget_reservations
    where user_id = p_user and provider = p_provider and day = v_day and status <> 'released';
  select coalesce(sum(coalesce(actual_usd, est_usd)), 0) into u_usd from budget_reservations
    where user_id = p_user and provider like 'assemblyai%' and day = v_day and status <> 'released';
  select coalesce(sum(coalesce(actual_units, units)), 0) into p_units_used from budget_reservations
    where provider = p_provider and day = v_day and status <> 'released';
  select coalesce(sum(coalesce(actual_usd, est_usd)), 0) into p_usd from budget_reservations
    where day = v_day and status <> 'released' and provider like 'assemblyai%';
  select coalesce(sum(coalesce(actual_usd, est_usd)), 0) + (select coalesce(sum(usd), 0) from budget_rollup where provider like 'assemblyai%')
    into life_usd from budget_reservations where status <> 'released' and provider like 'assemblyai%';
  if p_user is not null and u_units + p_units > p_user_daily_units then return query select false, 'user_daily_units', null::uuid; return; end if;
  if p_units_used + p_units > p_project_daily_units then return query select false, 'project_daily_units', null::uuid; return; end if;
  if p_user is not null and p_provider like 'assemblyai%' and u_usd + p_est_usd > p_user_daily_usd then return query select false, 'user_daily_usd', null::uuid; return; end if;
  if p_provider like 'assemblyai%' and p_usd + p_est_usd > p_project_daily_usd then return query select false, 'project_daily_usd', null::uuid; return; end if;
  if p_provider like 'assemblyai%' and life_usd + p_est_usd > p_lifetime_spendable_usd then return query select false, 'protected_reserve', null::uuid; return; end if;
  insert into budget_reservations (user_id, provider, day, units, est_usd)
    values (p_user, p_provider, v_day, p_units, p_est_usd) returning id into v_id;
  return query select true, null::text, v_id;
end $$;

-- v3 reservation (0003 signature + a trailing optional profile). Same global lock; lifetime includes the rollup.
drop function if exists public.reserve_budget_v3(text,uuid,text,text,numeric,numeric,text,numeric,numeric,int,numeric,numeric,int,numeric,numeric,int,numeric);
create or replace function public.reserve_budget_v3(
  p_subject text, p_user uuid, p_pool text, p_provider text, p_units numeric, p_est_usd numeric, p_ref text,
  p_subject_daily_units numeric, p_subject_daily_usd numeric, p_subject_daily_count int,
  p_pool_daily_units numeric, p_pool_daily_usd numeric, p_pool_daily_count int,
  p_project_daily_units numeric, p_project_daily_usd numeric, p_project_daily_count int,
  p_lifetime_spendable_usd numeric,
  p_stt_profile text default null
) returns table (ok boolean, reason text, reservation_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  s_units numeric; s_count int; s_usd numeric;
  g_units numeric; g_count int; g_usd numeric;
  p_units_used numeric; p_count int; p_usd numeric; life_usd numeric;
  v_id uuid;
  v_is_aai boolean := p_provider like 'assemblyai%';
begin
  perform public.budget_lock(); -- E47: the SAME lock as reserve_budget / settle_* / purge
  perform sweep_stale_reservations();

  select coalesce(sum(coalesce(actual_units, units)), 0), count(*) into s_units, s_count from budget_reservations
   where subject = p_subject and provider = p_provider and day = v_day and status <> 'released';
  select coalesce(sum(coalesce(actual_usd, est_usd)), 0) into s_usd from budget_reservations
   where subject = p_subject and provider like 'assemblyai%' and day = v_day and status <> 'released';
  select coalesce(sum(coalesce(actual_units, units)), 0), count(*) into p_units_used, p_count from budget_reservations
   where provider = p_provider and day = v_day and status <> 'released';
  select coalesce(sum(coalesce(actual_usd, est_usd)), 0) into p_usd from budget_reservations
   where provider like 'assemblyai%' and day = v_day and status <> 'released';
  select coalesce(sum(coalesce(actual_usd, est_usd)), 0) + (select coalesce(sum(usd), 0) from budget_rollup where provider like 'assemblyai%')
    into life_usd from budget_reservations where provider like 'assemblyai%' and status <> 'released';

  if p_subject_daily_units is not null and s_units + p_units > p_subject_daily_units then return query select false, 'user_daily_units', null::uuid; return; end if;
  if p_subject_daily_count is not null and s_count + 1 > p_subject_daily_count then return query select false, 'user_daily_requests', null::uuid; return; end if;
  if v_is_aai and p_subject_daily_usd is not null and s_usd + p_est_usd > p_subject_daily_usd then return query select false, 'user_daily_usd', null::uuid; return; end if;

  if p_pool is not null then
    select coalesce(sum(coalesce(actual_units, units)), 0), count(*) into g_units, g_count from budget_reservations
     where pool = p_pool and provider = p_provider and day = v_day and status <> 'released';
    select coalesce(sum(coalesce(actual_usd, est_usd)), 0) into g_usd from budget_reservations
     where pool = p_pool and provider like 'assemblyai%' and day = v_day and status <> 'released';
    if p_pool_daily_units is not null and g_units + p_units > p_pool_daily_units then return query select false, 'guest_pool', null::uuid; return; end if;
    if p_pool_daily_count is not null and g_count + 1 > p_pool_daily_count then return query select false, 'guest_pool', null::uuid; return; end if;
    if v_is_aai and p_pool_daily_usd is not null and g_usd + p_est_usd > p_pool_daily_usd then return query select false, 'guest_pool', null::uuid; return; end if;
  end if;

  if p_project_daily_units is not null and p_units_used + p_units > p_project_daily_units then return query select false, 'project_daily_units', null::uuid; return; end if;
  if p_project_daily_count is not null and p_count + 1 > p_project_daily_count then return query select false, 'project_daily_requests', null::uuid; return; end if;
  if v_is_aai and p_project_daily_usd is not null and p_usd + p_est_usd > p_project_daily_usd then return query select false, 'project_daily_usd', null::uuid; return; end if;
  if v_is_aai and life_usd + p_est_usd > p_lifetime_spendable_usd then return query select false, 'protected_reserve', null::uuid; return; end if;

  insert into budget_reservations (user_id, subject, pool, provider, day, units, est_usd, ref, stt_profile)
    values (p_user, p_subject, p_pool, p_provider, v_day, p_units, p_est_usd, p_ref, p_stt_profile) returning id into v_id;
  return query select true, null::text, v_id;
end $$;

create or replace function public.settle_budget(p_id uuid, p_commit boolean, p_actual_units numeric, p_actual_usd numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.budget_lock();
  update budget_reservations
     set status = case when p_commit then 'committed' else 'released' end,
         actual_units = p_actual_units, actual_usd = p_actual_usd, settled_at = now()
   where id = p_id and status = 'reserved';
end $$;

create or replace function public.settle_by_ref(p_ref text, p_provider text, p_commit boolean, p_actual_units numeric, p_authoritative boolean)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform public.budget_lock(); -- an authoritative re-commit can RAISE a released row's usage: must serialize with reservations
  if not p_commit then
    update budget_reservations set status = 'released', actual_units = 0, actual_usd = 0, settled_at = now()
     where ref = p_ref and provider = p_provider and status = 'reserved';
  else
    update budget_reservations
       set status = 'committed', settled_at = now(),
           actual_units = least(units, greatest(0, coalesce(p_actual_units, units))),
           actual_usd = case when units > 0 then est_usd * least(units, greatest(0, coalesce(p_actual_units, units))) / units else 0 end
     where ref = p_ref and provider = p_provider
       and (status = 'reserved' or (p_authoritative and status in ('committed', 'released')));
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- ================================================================================================ E49: retention
-- Spend history is ACCOUNTING for the project's provider credit: purged rows are rolled up first, so the lifetime
-- protected-reserve check never re-opens by deleting history.
create or replace function public.purge_budget_history(p_older_than interval default interval '90 days')
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform public.budget_lock();
  with gone as (
    delete from budget_reservations
     where created_at < now() - p_older_than and status <> 'reserved'
    returning provider, status, coalesce(actual_units, units) as u, coalesce(actual_usd, est_usd) as d
  ), agg as (
    select provider, sum(u) as u, sum(d) as d, count(*) as c from gone where status = 'committed' group by provider
  ), ins as (
    insert into budget_rollup (provider, units, usd, rows_purged)
      select provider, u, d, c from agg
    on conflict (provider) do update
      set units = budget_rollup.units + excluded.units, usd = budget_rollup.usd + excluded.usd,
          rows_purged = budget_rollup.rows_purged + excluded.rows_purged, updated_at = now()
    returning 1
  )
  select (select count(*) from gone) into n;
  return n;
end $$;

-- 0001's purge_old_metadata deleted budget_reservations directly (losing the lifetime figure). Keep the function name
-- for existing schedules but route budget history through the rollup.
create or replace function public.purge_old_metadata() returns void language plpgsql security definer set search_path = public as $$
begin
  delete from usage_events where created_at < now() - interval '30 days';
  delete from audit_events where created_at < now() - interval '90 days';
  perform public.purge_budget_history(interval '90 days');
  delete from session_members where joined_at < now() - interval '30 days';
  delete from conversation_sessions where started_at < now() - interval '30 days' and ended_at is not null;
  delete from approval_uses where expires_at < now() - interval '1 day';
end $$;

-- One entry point for the scheduler. Returns per-table counts (content-free) so the cron route can log them.
create or replace function public.purge_all_metadata() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb := '{}'::jsonb;
  n int;
begin
  -- Sessions that were never closed (crash, closed tab, worker never reported) would hold the one-active-session
  -- unique index forever: close them first. Max session is 20 minutes, so 2 hours is generous.
  update conversation_sessions set ended_at = now(), end_reason = 'timeout' where ended_at is null and started_at < now() - interval '2 hours';
  get diagnostics n = row_count; r := r || jsonb_build_object('stale_sessions_closed', n);

  delete from usage_events where created_at < now() - interval '30 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('usage_events', n);
  delete from audit_events where created_at < now() - interval '90 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('audit_events', n);
  delete from session_members where joined_at < now() - interval '30 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('session_members', n);
  delete from conversation_sessions where started_at < now() - interval '30 days' and ended_at is not null;
  get diagnostics n = row_count; r := r || jsonb_build_object('conversation_sessions', n);
  delete from approval_uses where expires_at < now() - interval '1 day';
  get diagnostics n = row_count; r := r || jsonb_build_object('approval_uses', n);
  delete from invite_uses where expires_at < now() - interval '1 day';
  get diagnostics n = row_count; r := r || jsonb_build_object('invite_uses', n);
  delete from guard_events where at < now() - interval '1 day';
  get diagnostics n = row_count; r := r || jsonb_build_object('guard_events', n);
  delete from phone_pair_codes where expires_at < now();
  get diagnostics n = row_count; r := r || jsonb_build_object('phone_pair_codes', n);
  delete from phone_calls where started_at < now() - interval '90 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('phone_calls', n);
  -- soft-deleted phrase rows only need to live long enough for other devices to learn about the deletion
  delete from phrases where deleted_at is not null and deleted_at < now() - interval '60 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('phrases', n);
  delete from phrase_boards where deleted_at is not null and deleted_at < now() - interval '60 days';
  get diagnostics n = row_count; r := r || jsonb_build_object('phrase_boards', n);
  n := public.purge_budget_history(interval '90 days');
  r := r || jsonb_build_object('budget_reservations_rolled_up', n);
  return r;
end $$;

-- Optional in-database schedule (Supabase has pg_cron; plain Postgres may not). The web app's /api/cron/purge (Vercel Cron)
-- is the portable scheduler; running both is harmless (the purge is idempotent).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('revoice-purge');
    exception when others then null;
    end;
    perform cron.schedule('revoice-purge', '17 3 * * *', 'select public.purge_all_metadata()');
  end if;
exception when others then
  raise notice 'pg_cron schedule skipped: %', sqlerrm;
end $$;

-- ================================================================================================ E48: use the tables
-- Phrase boards / phrases: two-way sync (last-writer-wins on updated_at, soft delete so deletions propagate).
alter table public.profiles add column if not exists updated_at timestamptz not null default now();
alter table public.phrase_boards add column if not exists updated_at timestamptz not null default now();
alter table public.phrase_boards add column if not exists deleted_at timestamptz;
alter table public.phrases add column if not exists updated_at timestamptz not null default now();
alter table public.phrases add column if not exists deleted_at timestamptz;
alter table public.phrases add column if not exists uses int not null default 0 check (uses >= 0);
create index if not exists phrase_boards_user_updated on public.phrase_boards(user_id, updated_at);
create index if not exists phrases_user_updated on public.phrases(user_id, updated_at);

-- A phrase may only hang off a board of the SAME owner (the FK alone would accept someone else's board id).
drop policy if exists owner_all on public.phrases;
create policy owner_all on public.phrases for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.phrase_boards b where b.id = board_id and b.user_id = auth.uid()));

-- Free-tier hygiene: bound what one account can store.
create or replace function public.enforce_phrase_caps() returns trigger language plpgsql as $$
declare n int;
begin
  if tg_table_name = 'phrase_boards' then
    select count(*) into n from public.phrase_boards where user_id = new.user_id and deleted_at is null and id <> new.id;
    if new.deleted_at is null and n >= 40 then raise exception 'board_cap' using errcode = '23514'; end if;
  else
    select count(*) into n from public.phrases where user_id = new.user_id and deleted_at is null and id <> new.id;
    if new.deleted_at is null and n >= 600 then raise exception 'phrase_cap' using errcode = '23514'; end if;
  end if;
  return new;
end $$;
drop trigger if exists phrase_boards_caps on public.phrase_boards;
create trigger phrase_boards_caps before insert or update on public.phrase_boards for each row execute function public.enforce_phrase_caps();
drop trigger if exists phrases_caps on public.phrases;
create trigger phrases_caps before insert or update on public.phrases for each row execute function public.enforce_phrase_caps();

-- Conversation sessions & members (server-written; owners can read their own rows — see 0001 policies).
alter table public.conversation_sessions drop constraint if exists conversation_sessions_end_reason_check;
alter table public.conversation_sessions add constraint conversation_sessions_end_reason_check
  check (end_reason is null or end_reason in ('user','timeout','budget','room_exit','error','idle','replaced'));
alter table public.conversation_sessions add column if not exists stt_profile text check (stt_profile is null or stt_profile in ('flagship','economy'));

create or replace function public.session_open(p_user uuid, p_room text, p_conv text, p_mode text, p_generation int, p_max_minutes int, p_stt_profile text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  -- a user has ONE active conversation: anything still open for them is stale (the live check is done against LiveKit).
  update conversation_sessions set ended_at = now(), end_reason = 'replaced' where user_id = p_user and ended_at is null;
  insert into conversation_sessions (user_id, room_name, conversation_ref, mode, generation, max_minutes, stt_profile)
    values (p_user, p_room, p_conv, p_mode, p_generation, greatest(1, least(20, p_max_minutes)), p_stt_profile)
    returning id into v_id;
  insert into session_members (session_id, user_id, participant_identity, role) values (v_id, p_user, 'owner', 'owner');
  return v_id;
end $$;

create or replace function public.session_close(p_room text, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update conversation_sessions set ended_at = now(), end_reason = case when p_reason in ('user','timeout','budget','room_exit','error','idle','replaced') then p_reason else 'error' end
   where room_name = p_room and ended_at is null;
  get diagnostics n = row_count;
  update session_members m set left_at = now() from conversation_sessions s
   where m.session_id = s.id and s.room_name = p_room and m.left_at is null;
  return n;
end $$;

create or replace function public.session_generation(p_room text, p_generation int) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update conversation_sessions set generation = greatest(generation, p_generation) where room_name = p_room and ended_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- Partner/caller joins (participant identity only: no names, numbers or audio).
create or replace function public.session_member_join(p_room text, p_identity text, p_role text) returns boolean
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  select id, user_id into s from conversation_sessions where room_name = p_room and ended_at is null;
  if not found then return false; end if;
  insert into session_members (session_id, user_id, participant_identity, role) values (s.id, s.user_id, left(p_identity, 128), p_role);
  return true;
end $$;

-- Pair codes: the DURABLE, atomic store (the owner room's LiveKit metadata stays as the fallback). One live code per user.
create or replace function public.phone_pair_issue(p_user uuid, p_room text, p_code_hash text, p_expires timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare v_session uuid;
begin
  select id into v_session from conversation_sessions where room_name = p_room and user_id = p_user and ended_at is null;
  delete from phone_pair_codes where user_id = p_user or expires_at < now();
  insert into phone_pair_codes (code_hash, user_id, session_id, room_name, expires_at) values (p_code_hash, p_user, v_session, p_room, p_expires)
  on conflict (code_hash) do update set user_id = excluded.user_id, session_id = excluded.session_id, room_name = excluded.room_name, attempts = 0, expires_at = excluded.expires_at;
end $$;

-- ATOMIC attempt counting (row lock): two concurrent binds cannot both read attempts=2 and both get "the third guess".
create or replace function public.phone_pair_lookup(p_code_hash text, p_max_attempts int)
returns table (ok boolean, room text, owner uuid, attempts int)
language plpgsql security definer set search_path = public as $$
declare r phone_pair_codes%rowtype;
begin
  select * into r from phone_pair_codes where code_hash = p_code_hash for update;
  if not found then return query select false, null::text, null::uuid, 0; return; end if;
  if r.expires_at < now() or r.attempts + 1 > p_max_attempts then
    delete from phone_pair_codes where code_hash = p_code_hash;
    return query select false, null::text, null::uuid, r.attempts; return;
  end if;
  update phone_pair_codes set attempts = phone_pair_codes.attempts + 1 where code_hash = p_code_hash;
  return query select true, r.room_name, r.user_id, r.attempts + 1;
end $$;

create or replace function public.phone_pair_consume(p_code_hash text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from phone_pair_codes where code_hash = p_code_hash;
  get diagnostics n = row_count;
  return n > 0;
end $$;

create or replace function public.phone_pair_revoke(p_user uuid) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from phone_pair_codes where user_id = p_user;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.phone_pair_burn_all() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from phone_pair_codes;
  get diagnostics n = row_count;
  return n;
end $$;

-- ================================================================================================ F: budget, variance, consent
-- Re-check a RUNNING room (worker heartbeat -> /api/worker/usage). Read-only: the session's own minutes are already reserved.
create or replace function public.room_budget_status(p_room text, p_project_daily_usd numeric, p_lifetime_spendable_usd numeric, p_reported_minutes numeric)
returns table (ok boolean, reason text, reservation_status text, project_day_usd numeric, lifetime_usd numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  r record; p_usd numeric; life numeric;
begin
  select coalesce(sum(coalesce(actual_usd, est_usd)), 0) into p_usd from budget_reservations
   where provider like 'assemblyai%' and day = v_day and status <> 'released';
  select coalesce(sum(coalesce(actual_usd, est_usd)), 0) + (select coalesce(sum(usd), 0) from budget_rollup where provider like 'assemblyai%')
    into life from budget_reservations where provider like 'assemblyai%' and status <> 'released';
  select status, units into r from budget_reservations where ref = p_room and provider like 'assemblyai_stt%' order by created_at desc limit 1;
  if found then
    if r.status = 'released' then return query select false, 'reservation_released', r.status, p_usd, life; return; end if;
    if r.status = 'committed' then return query select false, 'reservation_closed', r.status, p_usd, life; return; end if;
    if p_reported_minutes > r.units + 1 then return query select false, 'reservation_exhausted', r.status, p_usd, life; return; end if;
  end if;
  if p_usd > p_project_daily_usd + 0.0001 then return query select false, 'project_daily_usd', r.status, p_usd, life; return; end if;
  if life > p_lifetime_spendable_usd + 0.0001 then return query select false, 'protected_reserve', r.status, p_usd, life; return; end if;
  return query select true, null::text, r.status, p_usd, life;
end $$;

-- Estimate vs actual (what the app RESERVED vs what the provider/worker MEASURED), per provider, for the reconciliation panel.
create or replace function public.usage_variance(p_since date)
returns table (provider text, committed_rows bigint, reserved_units numeric, actual_units numeric, est_usd numeric, actual_usd numeric, open_rows bigint, released_rows bigint)
language sql security definer set search_path = public as $$
  select b.provider,
         count(*) filter (where b.status = 'committed'),
         coalesce(sum(b.units) filter (where b.status = 'committed' and b.actual_units is not null), 0),
         coalesce(sum(b.actual_units) filter (where b.status = 'committed' and b.actual_units is not null), 0),
         coalesce(sum(b.est_usd) filter (where b.status = 'committed' and b.actual_units is not null), 0),
         coalesce(sum(b.actual_usd) filter (where b.status = 'committed' and b.actual_units is not null), 0),
         count(*) filter (where b.status = 'reserved'),
         count(*) filter (where b.status = 'released')
    from budget_reservations b
   where b.day >= p_since
   group by b.provider
$$;

-- Consent history is APPEND-ONLY. Direct UPDATE is never allowed; DELETE only when the whole account (or voice) is
-- being erased by a cascade (the parent row is already gone).
alter table public.biometric_consents add column if not exists terms_version text not null default 'v1' check (char_length(terms_version) <= 16);
create or replace function public.consent_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'biometric_consents is append-only' using errcode = '42501';
  end if;
  -- DELETE: allowed only for cascades from a deleted voice profile / account
  if exists (select 1 from public.voice_profiles v where v.id = old.voice_profile_id) then
    raise exception 'biometric_consents is append-only' using errcode = '42501';
  end if;
  return old;
end $$;
drop trigger if exists biometric_consents_append_only on public.biometric_consents;
create trigger biometric_consents_append_only before update or delete on public.biometric_consents for each row execute function public.consent_append_only();

-- ================================================================================================ privileges
revoke all on function public.budget_lock() from public, anon, authenticated;
revoke all on function public.reserve_budget(uuid,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric) from public, anon, authenticated;
revoke all on function public.reserve_budget_v3(text,uuid,text,text,numeric,numeric,text,numeric,numeric,int,numeric,numeric,int,numeric,numeric,int,numeric,text) from public, anon, authenticated;
revoke all on function public.settle_budget(uuid,boolean,numeric,numeric) from public, anon, authenticated;
revoke all on function public.settle_by_ref(text,text,boolean,numeric,boolean) from public, anon, authenticated;
revoke all on function public.purge_budget_history(interval) from public, anon, authenticated;
revoke all on function public.purge_old_metadata() from public, anon, authenticated;
revoke all on function public.purge_all_metadata() from public, anon, authenticated;
revoke all on function public.session_open(uuid,text,text,text,int,int,text) from public, anon, authenticated;
revoke all on function public.session_close(text,text) from public, anon, authenticated;
revoke all on function public.session_generation(text,int) from public, anon, authenticated;
revoke all on function public.session_member_join(text,text,text) from public, anon, authenticated;
revoke all on function public.phone_pair_issue(uuid,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.phone_pair_lookup(text,int) from public, anon, authenticated;
revoke all on function public.phone_pair_consume(text) from public, anon, authenticated;
revoke all on function public.phone_pair_revoke(uuid) from public, anon, authenticated;
revoke all on function public.phone_pair_burn_all() from public, anon, authenticated;
revoke all on function public.room_budget_status(text,numeric,numeric,numeric) from public, anon, authenticated;
revoke all on function public.usage_variance(date) from public, anon, authenticated;
