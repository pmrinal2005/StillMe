-- ReVOICE minimal durable schema (Supabase Free).
-- Principles: owner-based RLS on every user-owned table; no transcripts, drafts, audio or
-- clone samples are stored; audit/usage events are content-free.
-- Live transcripts and candidate sets stay in memory only.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles & preferences
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  created_at timestamptz not null default now()
);

create table if not exists public.accessibility_prefs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  text_scale numeric not null default 1 check (text_scale between 0.75 and 3),
  target_rem numeric not null default 3.25 check (target_rem between 2 and 8),
  high_contrast boolean not null default false,
  reduced_motion boolean not null default false,
  scanning boolean not null default false,
  scan_interval_ms int not null default 1500 check (scan_interval_ms between 600 and 10000),
  confirm_before_speak boolean not null default false,
  input_languages text[] not null default '{}',
  output_language text not null default 'english'
    check (output_language in ('english','spanish','german','italian','portuguese','french')),
  updated_at timestamptz not null default now()
);

-- User-authored writing preferences (not inferred personality). Short by design.
create table if not exists public.style_cards (
  user_id uuid primary key references auth.users(id) on delete cascade,
  style text not null default '' check (char_length(style) <= 600),
  keyterms text[] not null default '{}' check (cardinality(keyterms) <= 30),
  context_prompt text not null default '' check (char_length(context_prompt) <= 300),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- voices & consent
create table if not exists public.voice_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('library','cloned')),
  provider_voice_id text not null check (char_length(provider_voice_id) <= 128),
  provider_account_ref text check (char_length(provider_account_ref) <= 128),
  label text not null check (char_length(label) <= 80),
  region text not null check (region in ('us','eu')),
  recording_language text check (recording_language in ('english','spanish','german','italian','portuguese','french')),
  provenance text check (provenance in ('self-recorded','voicemail','other-recording')),
  provenance_note text check (char_length(provenance_note) <= 300),
  fallback_voice_id text not null default 'aai-audrey',
  revoked boolean not null default false,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, provider_voice_id)
);

create table if not exists public.biometric_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  voice_profile_id uuid not null references public.voice_profiles(id) on delete cascade,
  speaker_consent boolean not null,
  rights_confirmed boolean not null,
  biometric_terms_accepted boolean not null,
  consented_at timestamptz not null default now(),
  expected_expiry timestamptz not null,
  provider_expires_at timestamptz,
  action text not null check (action in ('initial','renewal','revocation')),
  check (action = 'revocation' or (speaker_consent and rights_confirmed and biometric_terms_accepted))
);

-- ---------------------------------------------------------------- phrase boards
create table if not exists public.phrase_boards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) <= 40),
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.phrases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  board_id uuid not null references public.phrase_boards(id) on delete cascade,
  text text not null check (char_length(text) <= 400),
  sort int not null default 0,
  cacheable boolean not null default false, -- owner authorized caching synthesized audio for this phrase
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- sessions
create table if not exists public.conversation_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  room_name text not null unique,
  conversation_ref text not null,
  mode text not null check (mode in ('tabletop','partner-link','remote','phone')),
  generation int not null default 0,
  max_minutes int not null check (max_minutes between 1 and 20),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text check (end_reason in ('user','timeout','budget','room_exit','error','idle'))
);
-- One active conversation per user.
create unique index if not exists one_active_session_per_user
  on public.conversation_sessions(user_id) where ended_at is null;

create table if not exists public.session_members (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.conversation_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade, -- owner of the session
  participant_identity text not null,
  role text not null check (role in ('owner','partner','caller')),
  joined_at timestamptz not null default now(),
  left_at timestamptz
);

-- ---------------------------------------------------------------- budgets & usage
create table if not exists public.budget_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade, -- null = project-wide
  provider text not null check (provider in ('assemblyai_tts','assemblyai_stt','groq','livekit_agent','livekit_phone')),
  day date not null default (now() at time zone 'utc')::date,
  units numeric not null check (units >= 0),        -- chars | minutes | tokens
  est_usd numeric not null default 0 check (est_usd >= 0),
  status text not null default 'reserved' check (status in ('reserved','committed','released')),
  actual_units numeric,
  actual_usd numeric,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists budget_reservations_day on public.budget_reservations(day, provider);

-- Content-free usage events (request ids, durations, totals, error categories).
create table if not exists public.usage_events (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  provider text not null,
  kind text not null check (char_length(kind) <= 40),
  units numeric,
  est_usd numeric,
  provider_request_id text check (char_length(provider_request_id) <= 80),
  duration_ms int,
  error_category text check (char_length(error_category) <= 40),
  created_at timestamptz not null default now()
);

-- Provider-reported usage, entered from dashboards for reconciliation (no content).
create table if not exists public.provider_reconciliations (
  id bigserial primary key,
  provider text not null check (provider in ('assemblyai','groq','livekit','supabase','vercel')),
  period_start date not null,
  period_end date not null,
  provider_reported_usd numeric,
  provider_reported_units jsonb not null default '{}',
  app_estimated_usd numeric,
  note text check (char_length(note) <= 300),
  recorded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Single-use approval ids (replay protection across instances). No text stored, only hashes.
create table if not exists public.approval_uses (
  approval_id text primary key,
  user_id uuid references auth.users(id) on delete cascade,
  text_hash text not null check (text_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz not null default now()
);

create table if not exists public.audit_events (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  evt text not null check (char_length(evt) <= 40), -- e.g. consent_renewed, voice_revoked, export, delete
  ref text check (char_length(ref) <= 64),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS: owner-only everywhere
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','accessibility_prefs','style_cards','voice_profiles','biometric_consents',
    'phrase_boards','phrases','conversation_sessions','session_members','budget_reservations',
    'usage_events','approval_uses','audit_events','provider_reconciliations'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- Owner read/write tables.
do $$
declare t text;
begin
  foreach t in array array['profiles','accessibility_prefs','style_cards','voice_profiles','phrase_boards','phrases'] loop
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- Consent records: owner may read and insert (append-only history), never update/delete directly.
drop policy if exists owner_read on public.biometric_consents;
create policy owner_read on public.biometric_consents for select to authenticated using (user_id = auth.uid());
drop policy if exists owner_insert on public.biometric_consents;
create policy owner_insert on public.biometric_consents for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.voice_profiles v where v.id = voice_profile_id and v.user_id = auth.uid()));

-- Server-written tables: owner may read their own rows; writes happen via service role or SECURITY DEFINER RPCs.
do $$
declare t text;
begin
  foreach t in array array['conversation_sessions','session_members','budget_reservations','usage_events','approval_uses','audit_events'] loop
    execute format('drop policy if exists owner_read on public.%I', t);
    execute format('create policy owner_read on public.%I for select to authenticated using (user_id = auth.uid())', t);
  end loop;
end $$;
-- provider_reconciliations: no client policies (service role only).

-- ---------------------------------------------------------------- transactional reservation RPC
-- Atomically checks intersecting daily caps (per-user AND project-wide) and inserts a reservation.
-- Serialized per (provider, day) with an advisory transaction lock so concurrent instances
-- cannot both pass the check. Called by the server with the service role.
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
  perform pg_advisory_xact_lock(hashtext(p_provider || ':' || v_day::text));
  select coalesce(sum(coalesce(actual_units, units)), 0), coalesce(sum(coalesce(actual_usd, est_usd)), 0)
    into u_units, u_usd from budget_reservations
    where user_id = p_user and provider = p_provider and day = v_day and status <> 'released';
  select coalesce(sum(coalesce(actual_units, units)), 0) into p_units_used from budget_reservations
    where provider = p_provider and day = v_day and status <> 'released';
  select coalesce(sum(coalesce(actual_usd, est_usd)), 0) into p_usd from budget_reservations
    where day = v_day and status <> 'released' and provider like 'assemblyai%';
  select coalesce(sum(coalesce(actual_usd, est_usd)), 0) into life_usd from budget_reservations
    where status <> 'released' and provider like 'assemblyai%';
  if u_units + p_units > p_user_daily_units then return query select false, 'user_daily_units', null::uuid; return; end if;
  if p_units_used + p_units > p_project_daily_units then return query select false, 'project_daily_units', null::uuid; return; end if;
  if u_usd + p_est_usd > p_user_daily_usd then return query select false, 'user_daily_usd', null::uuid; return; end if;
  if p_usd + p_est_usd > p_project_daily_usd then return query select false, 'project_daily_usd', null::uuid; return; end if;
  if life_usd + p_est_usd > p_lifetime_spendable_usd then return query select false, 'protected_reserve', null::uuid; return; end if;
  insert into budget_reservations (user_id, provider, day, units, est_usd)
    values (p_user, p_provider, v_day, p_units, p_est_usd) returning id into v_id;
  return query select true, null::text, v_id;
end $$;

create or replace function public.settle_budget(p_id uuid, p_commit boolean, p_actual_units numeric, p_actual_usd numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  update budget_reservations
     set status = case when p_commit then 'committed' else 'released' end,
         actual_units = p_actual_units, actual_usd = p_actual_usd, settled_at = now()
   where id = p_id and status = 'reserved';
end $$;

-- Single-use approval consumption. Returns false if already used (replay).
create or replace function public.consume_approval(p_approval_id text, p_user uuid, p_text_hash text, p_expires_at timestamptz)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  delete from approval_uses where expires_at < now() - interval '1 day';
  insert into approval_uses (approval_id, user_id, text_hash, expires_at) values (p_approval_id, p_user, p_text_hash, p_expires_at);
  return true;
exception when unique_violation then
  return false;
end $$;

revoke all on function public.reserve_budget(uuid,text,numeric,numeric,numeric,numeric,numeric,numeric,numeric) from public, anon, authenticated;
revoke all on function public.settle_budget(uuid,boolean,numeric,numeric) from public, anon, authenticated;
revoke all on function public.consume_approval(text,uuid,text,timestamptz) from public, anon, authenticated;

-- ---------------------------------------------------------------- retention (short metadata retention)
-- Run daily (e.g. Supabase scheduled function or manual): delete content-free metadata older than 30/90 days.
create or replace function public.purge_old_metadata() returns void language sql security definer set search_path = public as $$
  delete from usage_events where created_at < now() - interval '30 days';
  delete from audit_events where created_at < now() - interval '90 days';
  delete from budget_reservations where created_at < now() - interval '90 days';
  delete from session_members where joined_at < now() - interval '30 days';
  delete from conversation_sessions where started_at < now() - interval '30 days';
  delete from approval_uses where expires_at < now() - interval '1 day';
$$;
revoke all on function public.purge_old_metadata() from public, anon, authenticated;
