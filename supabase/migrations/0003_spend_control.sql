-- 0003: Critical budget & spend-control fixes (A1–A10).
--
--  * Every reservation now has a SUBJECT (user uuid as text, or a hashed guest key) so guests are
--    enforced durably across all serverless instances (A5), plus an optional POOL ('guest') that caps
--    all guests together.
--  * `ref` links a reservation to a room (STT) or an approval (worker TTS) so the worker can settle it
--    on ANY instance (A1, A3, A10) and the end route can find it without a ticket (A2).
--  * Request-count caps let Groq requests/day be enforced durably (A6).
--  * Stale reservations are swept lazily on every reservation (A3): STT rows are committed at the last
--    worker-reported connected time (A10) — or in full if the worker never reported — never left "reserved".
--  * LiveKit agent minutes are recorded per room and capped per month (A10).
-- Content-free: no text, audio or transcripts.

alter table public.budget_reservations add column if not exists subject text;
alter table public.budget_reservations add column if not exists pool text check (pool is null or pool in ('guest'));
alter table public.budget_reservations add column if not exists ref text check (ref is null or char_length(ref) <= 96);
alter table public.budget_reservations add column if not exists progress_units numeric;
alter table public.budget_reservations add column if not exists progress_at timestamptz;

update public.budget_reservations set subject = user_id::text where subject is null and user_id is not null;

create index if not exists budget_reservations_subject on public.budget_reservations(subject, day);
create index if not exists budget_reservations_pool on public.budget_reservations(pool, day) where pool is not null;
create index if not exists budget_reservations_ref on public.budget_reservations(ref, provider) where ref is not null;
create index if not exists budget_reservations_open on public.budget_reservations(created_at) where status = 'reserved';
create unique index if not exists budget_reservations_agent_ref
  on public.budget_reservations(provider, ref) where provider = 'livekit_agent' and ref is not null;

-- ---------------------------------------------------------------- A3: sweep stale reservations
create or replace function public.sweep_stale_reservations() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with stale as (
    select id, provider, units, est_usd, progress_units, progress_at
      from budget_reservations
     where status = 'reserved'
       and created_at < now() - case when provider = 'assemblyai_stt' then (units + 10) * interval '1 minute'
                                     else interval '15 minutes' end
     for update skip locked
  ), calc as (
    select id, est_usd, units,
           case when provider = 'assemblyai_stt' and progress_at is not null
                then least(units, progress_units + 1)   -- +1 min: heartbeat lag
                else units end as used
      from stale
  )
  update budget_reservations b
     set status = 'committed', settled_at = now(),
         actual_units = c.used,
         actual_usd = case when c.units > 0 then c.est_usd * c.used / c.units else 0 end
    from calc c where b.id = c.id;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- subject/pool/project reservation
-- Null cap = not checked. USD caps sum ALL AssemblyAI providers (TTS + STT share the daily dollar limit).
create or replace function public.reserve_budget_v3(
  p_subject text, p_user uuid, p_pool text, p_provider text, p_units numeric, p_est_usd numeric, p_ref text,
  p_subject_daily_units numeric, p_subject_daily_usd numeric, p_subject_daily_count int,
  p_pool_daily_units numeric, p_pool_daily_usd numeric, p_pool_daily_count int,
  p_project_daily_units numeric, p_project_daily_usd numeric, p_project_daily_count int,
  p_lifetime_spendable_usd numeric
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
  perform pg_advisory_xact_lock(hashtext('budget:' || v_day::text));
  perform sweep_stale_reservations();

  select coalesce(sum(coalesce(actual_units, units)), 0), count(*) into s_units, s_count from budget_reservations
   where subject = p_subject and provider = p_provider and day = v_day and status <> 'released';
  select coalesce(sum(coalesce(actual_usd, est_usd)), 0) into s_usd from budget_reservations
   where subject = p_subject and provider like 'assemblyai%' and day = v_day and status <> 'released';
  select coalesce(sum(coalesce(actual_units, units)), 0), count(*) into p_units_used, p_count from budget_reservations
   where provider = p_provider and day = v_day and status <> 'released';
  select coalesce(sum(coalesce(actual_usd, est_usd)), 0) into p_usd from budget_reservations
   where provider like 'assemblyai%' and day = v_day and status <> 'released';
  select coalesce(sum(coalesce(actual_usd, est_usd)), 0) into life_usd from budget_reservations
   where provider like 'assemblyai%' and status <> 'released';

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

  insert into budget_reservations (user_id, subject, pool, provider, day, units, est_usd, ref)
    values (p_user, p_subject, p_pool, p_provider, v_day, p_units, p_est_usd, p_ref) returning id into v_id;
  return query select true, null::text, v_id;
end $$;

-- ---------------------------------------------------------------- settle by reference (room / approval)
-- p_authoritative = the WORKER's measured usage: may correct an already-committed (wall-clock) figure
-- downwards, never above the reservation. Non-authoritative settles only touch 'reserved' rows.
create or replace function public.settle_by_ref(p_ref text, p_provider text, p_commit boolean, p_actual_units numeric, p_authoritative boolean)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not p_commit then
    update budget_reservations set status = 'released', actual_units = 0, actual_usd = 0, settled_at = now()
     where ref = p_ref and provider = p_provider and status = 'reserved';
  else
    update budget_reservations
       set status = 'committed', settled_at = now(),
           actual_units = least(units, greatest(0, coalesce(p_actual_units, units))),
           actual_usd = case when units > 0 then est_usd * least(units, greatest(0, coalesce(p_actual_units, units))) / units else 0 end
     where ref = p_ref and provider = p_provider
       -- authoritative (worker-measured) usage also re-commits a row a client released/committed first
       and (status = 'reserved' or (p_authoritative and status in ('committed', 'released')));
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- Worker heartbeat: connected STT minutes so far (used by the sweep if the final report never arrives).
create or replace function public.progress_by_ref(p_ref text, p_provider text, p_units numeric)
returns void language sql security definer set search_path = public as $$
  update budget_reservations set progress_units = greatest(coalesce(progress_units, 0), p_units), progress_at = now()
   where ref = p_ref and provider = p_provider and status = 'reserved';
$$;

-- LiveKit agent minutes per room (idempotent: keeps the largest reported figure).
create or replace function public.record_agent_minutes(p_subject text, p_user uuid, p_ref text, p_units numeric)
returns void language sql security definer set search_path = public as $$
  insert into budget_reservations (user_id, subject, provider, units, est_usd, status, actual_units, actual_usd, ref, settled_at)
  values (p_user, p_subject, 'livekit_agent', p_units, 0, 'committed', p_units, 0, p_ref, now())
  on conflict (provider, ref) where provider = 'livekit_agent' and ref is not null
  do update set units = greatest(budget_reservations.units, excluded.units),
                actual_units = greatest(coalesce(budget_reservations.actual_units, 0), excluded.actual_units),
                settled_at = now();
$$;

create or replace function public.month_units(p_provider text)
returns numeric language sql security definer set search_path = public as $$
  select coalesce(sum(coalesce(actual_units, units)), 0) from budget_reservations
   where provider = p_provider and status <> 'released'
     and day >= date_trunc('month', now() at time zone 'utc')::date;
$$;

revoke all on function public.sweep_stale_reservations() from public, anon, authenticated;
revoke all on function public.reserve_budget_v3(text,uuid,text,text,numeric,numeric,text,numeric,numeric,int,numeric,numeric,int,numeric,numeric,int,numeric) from public, anon, authenticated;
revoke all on function public.settle_by_ref(text,text,boolean,numeric,boolean) from public, anon, authenticated;
revoke all on function public.progress_by_ref(text,text,numeric) from public, anon, authenticated;
revoke all on function public.record_agent_minutes(text,uuid,text,numeric) from public, anon, authenticated;
revoke all on function public.month_units(text) from public, anon, authenticated;
