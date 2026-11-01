-- 0002: inbound phone bridge (pair codes, call ledger with a 40-min monthly cap) + reconciliation helpers.
-- Content-free: pair codes are stored only as HMAC hashes; no caller numbers, audio or transcripts.

-- ---------------------------------------------------------------- pair codes (single use, short-lived)
create table if not exists public.phone_pair_codes (
  code_hash text primary key check (code_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.conversation_sessions(id) on delete cascade,
  room_name text not null check (char_length(room_name) <= 128),
  attempts int not null default 0 check (attempts between 0 and 10),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create unique index if not exists one_live_code_per_user on public.phone_pair_codes(user_id);

-- ---------------------------------------------------------------- calls (minutes ledger)
create table if not exists public.phone_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  room_name text not null check (char_length(room_name) <= 128),
  participant_identity text not null check (char_length(participant_identity) <= 128),
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  reserved_minutes int not null check (reserved_minutes between 1 and 15),
  used_minutes int check (used_minutes between 0 and 16),
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists phone_calls_month on public.phone_calls(month);

alter table public.phone_pair_codes enable row level security;
alter table public.phone_pair_codes force row level security;
alter table public.phone_calls enable row level security;
alter table public.phone_calls force row level security;

-- Owners can see (not write) their own calls; pair codes have NO client policies (service role only).
drop policy if exists owner_read on public.phone_calls;
create policy owner_read on public.phone_calls for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------- transactional call reservation
-- Project-wide monthly cap (default 40 of the 50 included minutes), serialized per month.
-- Unsettled reservations count as fully used until settled (conservative).
create or replace function public.reserve_phone_call(
  p_user uuid, p_room text, p_identity text, p_monthly_cap int default 40, p_per_call int default 15
) returns table (ok boolean, reason text, call_id uuid, minutes int)
language plpgsql security definer set search_path = public as $$
declare
  v_month text := to_char(now() at time zone 'utc', 'YYYY-MM');
  v_used int;
  v_allowed int;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('phone:' || v_month));
  select coalesce(sum(coalesce(used_minutes, reserved_minutes)), 0) into v_used from phone_calls where month = v_month;
  v_allowed := least(p_per_call, p_monthly_cap - v_used);
  if v_allowed <= 0 then
    return query select false, 'phone_cap', null::uuid, 0; return;
  end if;
  insert into phone_calls (user_id, room_name, participant_identity, month, reserved_minutes)
    values (p_user, p_room, p_identity, v_month, v_allowed) returning id into v_id;
  return query select true, null::text, v_id, v_allowed;
end $$;

create or replace function public.settle_phone_call(p_room text, p_used numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  update phone_calls
     set used_minutes = least(reserved_minutes, ceil(greatest(p_used, 0))::int), ended_at = now()
   where room_name = p_room and ended_at is null;
end $$;

-- Month summary for the reconciliation route.
create or replace function public.phone_month_usage(p_month text default to_char(now() at time zone 'utc', 'YYYY-MM'))
returns table (month text, minutes int, calls int)
language sql security definer set search_path = public as $$
  select p_month, coalesce(sum(coalesce(used_minutes, reserved_minutes)), 0)::int, count(*)::int
    from phone_calls where month = p_month;
$$;

revoke all on function public.reserve_phone_call(uuid,text,text,int,int) from public, anon, authenticated;
revoke all on function public.settle_phone_call(text,numeric) from public, anon, authenticated;
revoke all on function public.phone_month_usage(text) from public, anon, authenticated;

-- ---------------------------------------------------------------- reconciliation drift view (service role)
create or replace view public.reconciliation_drift as
  select provider, period_start, period_end, provider_reported_usd, app_estimated_usd,
         (provider_reported_usd - app_estimated_usd) as drift_usd, note, created_at
    from public.provider_reconciliations;
revoke all on public.reconciliation_drift from public, anon, authenticated;

-- ---------------------------------------------------------------- retention additions
create or replace function public.purge_old_phone_metadata() returns void language sql security definer set search_path = public as $$
  delete from phone_pair_codes where expires_at < now();
  delete from phone_calls where started_at < now() - interval '90 days';
$$;
revoke all on function public.purge_old_phone_metadata() from public, anon, authenticated;
