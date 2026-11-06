-- 0007: NO SIGN-IN.
--
-- ReVOICE no longer has accounts. Every browser is a DEVICE identified by a signed cookie; the server maps the device id
-- to a deterministic uuid and uses that uuid as `user_id` in the tables below. Those uuids are NOT rows in auth.users, so
-- every foreign key to auth.users must go, and the browser (anon / authenticated roles) must have no direct access at all:
-- the app now reaches Postgres ONLY from the server with the service-role key.
--
-- Idempotent: safe to run more than once, and safe on a database that never had some of the tables.

-- 1. Drop every foreign key from a public table to auth.users (names differ between migrations, so look them up).
do $$
declare r record;
begin
  for r in
    select c.conrelid::regclass as tbl, c.conname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where c.contype = 'f'
       and n.nspname = 'public'
       and c.confrelid = 'auth.users'::regclass
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
exception when undefined_table then
  null; -- no auth schema (plain Postgres): nothing to drop
end $$;

-- 2. The browser never talks to the database any more. Remove every client policy and every client privilege.
do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies where schemaname = 'public' and (roles && array['authenticated'::name, 'anon'::name]) loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- 3. Account-era leftovers that mean nothing without accounts (kept as empty tables; harmless).
comment on table public.profiles is 'Legacy (account era). Unused since 0007: ReVOICE has no sign-in.';
comment on table public.accessibility_prefs is 'Legacy (account era). Preferences now live only in the browser (IndexedDB).';
comment on table public.style_cards is 'Legacy (account era). Style card now lives only in the browser (IndexedDB).';
comment on table public.phrase_boards is 'Legacy (account era). Phrase boards now live only in the browser (IndexedDB).';
comment on table public.phrases is 'Legacy (account era). Phrases now live only in the browser (IndexedDB).';
