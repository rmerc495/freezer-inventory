-- Use the same household-first lock order as inventory and membership writes.
create or replace function public.join_household(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_invite private.household_invites; v_household_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  select household_id into v_household_id from private.household_invites
    where token_hash = sha256(convert_to(lower(btrim(p_code)), 'UTF8'));
  if not found then
    raise exception 'This invitation is invalid or expired. Ask for a new code.' using errcode = '22023';
  end if;
  perform 1 from public.households where id = v_household_id for update;
  select * into v_invite from private.household_invites
    where token_hash = sha256(convert_to(lower(btrim(p_code)), 'UTF8')) for update;
  if not found or v_invite.expires_at <= now() then
    raise exception 'This invitation is invalid or expired. Ask for a new code.' using errcode = '22023';
  end if;
  if v_invite.used_by = auth.uid() then return v_invite.household_id; end if;
  if v_invite.used_at is not null then
    raise exception 'This invitation has already been used.' using errcode = '22023';
  end if;
  if exists (select 1 from public.household_members where household_id = v_invite.household_id and user_id = auth.uid()) then
    raise exception 'You already belong to this household.' using errcode = '22023';
  end if;
  insert into public.household_members(household_id, user_id) values (v_invite.household_id, auth.uid());
  update private.household_invites set used_by = auth.uid(), used_at = clock_timestamp()
    where token_hash = v_invite.token_hash;
  return v_invite.household_id;
end;
$$;
