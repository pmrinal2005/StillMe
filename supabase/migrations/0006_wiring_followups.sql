-- 0006: follow-ups that make the 0005 objects usable from the app.
--  F  settle_budget: when the caller knows the settled UNITS but not the USD (the STT profile's rate lives on the
--     reservation, not in the ticket), price them proportionally from the reservation's own est_usd. Before this an
--     economy-profile session settled at the flagship rate.
create or replace function public.settle_budget(p_id uuid, p_commit boolean, p_actual_units numeric, p_actual_usd numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.budget_lock();
  update budget_reservations
     set status = case when p_commit then 'committed' else 'released' end,
         actual_units = p_actual_units,
         actual_usd = case
           when p_actual_usd is not null then p_actual_usd
           when p_actual_units is not null and units > 0 then est_usd * p_actual_units / units
           else null end,
         settled_at = now()
   where id = p_id and status = 'reserved';
end $$;
revoke all on function public.settle_budget(uuid,boolean,numeric,numeric) from public, anon, authenticated;

-- Content-free consent history for the owner's Voice Identity Card (append-only table from 0005).
create or replace function public.consent_history(p_user uuid, p_limit int default 50)
returns table (voice_profile_id uuid, provider_voice_id text, action text, consented_at timestamptz, expected_expiry timestamptz, provider_expires_at timestamptz, terms_version text)
language sql security definer set search_path = public as $$
  select c.voice_profile_id, v.provider_voice_id, c.action, c.consented_at, c.expected_expiry, c.provider_expires_at, c.terms_version
    from biometric_consents c join voice_profiles v on v.id = c.voice_profile_id
   where c.user_id = p_user
   order by c.consented_at desc
   limit greatest(1, least(200, p_limit))
$$;
revoke all on function public.consent_history(uuid,int) from public, anon, authenticated;
