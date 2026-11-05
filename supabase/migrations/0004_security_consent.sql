-- 0004: Critical security, consent and authorization fixes (B11–B19).
--
--  B11/B12  Cloned-voice consent is now SERVER-SIDE. Until now the consent record lived in the browser
--           (IndexedDB) and was sent to /api/approve as an attestation, so anyone could claim any voice id with
--           any consent. voice_profiles/biometric_consents become write-protected for clients (service role only)
--           and carry the full consent record; a voice id can be claimed by ONE account (first verified claim).
--  B17      Partner invites are single use: consume_invite() is an atomic insert-or-fail on the invite id.
--  B15      guard_events backs the phone bind failure counters (per call / per identity / global), cross-instance.
--  B19      Account deletion: spend history must survive the auth user (budget_reservations used to CASCADE,
--           erasing spend and re-opening project caps); voice tombstones keep a deleted person's clone unusable.
-- Content-free: no text, audio, transcripts, phone numbers (identity keys are HMAC-hashed by the app).

-- ---------------------------------------------------------------- B11/B12: server-side voice registry
alter table public.voice_profiles add column if not exists owner_name text check (owner_name is null or char_length(owner_name) <= 80);
alter table public.voice_profiles add column if not exists speaker_consent boolean not null default false;
alter table public.voice_profiles add column if not exists rights_confirmed boolean not null default false;
alter table public.voice_profiles add column if not exists biometric_terms_accepted boolean not null default false;
alter table public.voice_profiles add column if not exists quality_checked boolean not null default false;
alter table public.voice_profiles add column if not exists consent_at timestamptz;
alter table public.voice_profiles add column if not exists provider_expires_at timestamptz;

-- A voice id is not a permission token: ONE account may hold the claim on a provider voice id (revoked rows keep
-- the claim so a revoked/deleted clone cannot be picked up by somebody else who learned the id).
create unique index if not exists voice_profiles_one_claim on public.voice_profiles(provider_voice_id) where kind = 'cloned';

-- Clients may READ their registry but never write it (consent must be recorded by the server after it checks the
-- provider). The old `owner_all` policy let a browser insert any voice with any consent / un-revoke it.
drop policy if exists owner_all on public.voice_profiles;
drop policy if exists owner_read on public.voice_profiles;
create policy owner_read on public.voice_profiles for select to authenticated using (user_id = auth.uid());
drop policy if exists owner_insert on public.biometric_consents; -- consent records are append-only AND server-written

-- Tombstones: clone ids of deleted accounts. Nobody may (re)register them.
create table if not exists public.voice_tombstones (
  provider_voice_id text primary key check (char_length(provider_voice_id) <= 128),
  region text not null check (region in ('us','eu')),
  reason text not null default 'account_deleted' check (char_length(reason) <= 40),
  tombstoned_at timestamptz not null default now()
);
alter table public.voice_tombstones enable row level security;
alter table public.voice_tombstones force row level security; -- no client policies: service role only

-- ---------------------------------------------------------------- B17: single-use partner invites
create table if not exists public.invite_uses (
  jti text primary key check (jti ~ '^[a-f0-9]{24}$'),
  room_name text not null check (char_length(room_name) <= 128),
  expires_at timestamptz not null,
  used_at timestamptz not null default now()
);
alter table public.invite_uses enable row level security;
alter table public.invite_uses force row level security;

-- Returns true exactly once per invite id (false = already used). Atomic on any instance.
create or replace function public.consume_invite(p_jti text, p_room text, p_expires_at timestamptz)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  delete from invite_uses where expires_at < now() - interval '1 day';
  insert into invite_uses (jti, room_name, expires_at) values (p_jti, p_room, p_expires_at);
  return true;
exception when unique_violation then
  return false;
end $$;

-- ---------------------------------------------------------------- B15: phone bind failure guard
create table if not exists public.guard_events (
  id bigserial primary key,
  key text not null check (char_length(key) <= 96), -- HMAC-hashed scope key (call room / caller identity / global)
  at timestamptz not null default now()
);
create index if not exists guard_events_key_at on public.guard_events(key, at desc);
alter table public.guard_events enable row level security;
alter table public.guard_events force row level security;

create or replace function public.guard_hit(p_key text, p_window_seconds int)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from guard_events where at < now() - interval '1 day';
  insert into guard_events (key) values (p_key);
  select count(*) into n from guard_events where key = p_key and at > now() - make_interval(secs => p_window_seconds);
  return n;
end $$;

create or replace function public.guard_count(p_key text, p_window_seconds int)
returns int language sql security definer set search_path = public as $$
  select count(*)::int from guard_events where key = p_key and at > now() - make_interval(secs => p_window_seconds);
$$;

-- ---------------------------------------------------------------- B19: account deletion
-- Spend history is accounting for the PROJECT's provider credit, not personal data: keep it when the user goes.
-- (It used to CASCADE: deleting an account erased its committed spend and re-opened the daily/lifetime caps.)
alter table public.budget_reservations drop constraint if exists budget_reservations_user_id_fkey;
alter table public.budget_reservations
  add constraint budget_reservations_user_id_fkey foreign key (user_id) references auth.users(id) on delete set null;

-- Settle everything a user still has open, conservatively (STT: elapsed minutes rounded up; speech/Groq: in full).
-- Nothing is refunded by deleting an account: the provider may already have billed it.
create or replace function public.settle_open_reservations(p_subject text)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update budget_reservations b
     set status = 'committed', settled_at = now(),
         actual_units = case when b.provider = 'assemblyai_stt'
                             then least(b.units, greatest(coalesce(b.progress_units, 0), ceil(extract(epoch from (now() - b.created_at)) / 60.0)))
                             else b.units end,
         actual_usd = case when b.units > 0 then b.est_usd *
                            (case when b.provider = 'assemblyai_stt'
                                  then least(b.units, greatest(coalesce(b.progress_units, 0), ceil(extract(epoch from (now() - b.created_at)) / 60.0)))
                                  else b.units end) / b.units
                           else 0 end
   where b.status = 'reserved' and b.subject = p_subject;
  get diagnostics n = row_count;
  return n;
end $$;

-- Retention: keep the new tables small.
create or replace function public.purge_old_security_metadata() returns void language sql security definer set search_path = public as $$
  delete from invite_uses where expires_at < now() - interval '1 day';
  delete from guard_events where at < now() - interval '1 day';
$$;

revoke all on function public.consume_invite(text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.guard_hit(text,int) from public, anon, authenticated;
revoke all on function public.guard_count(text,int) from public, anon, authenticated;
revoke all on function public.settle_open_reservations(text) from public, anon, authenticated;
revoke all on function public.purge_old_security_metadata() from public, anon, authenticated;
