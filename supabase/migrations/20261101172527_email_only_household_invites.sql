create or replace function public.create_household_email_invite(p_household_id uuid, p_email text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(btrim(p_email)); v_token text;
begin
  perform 1 from public.households where id = p_household_id and owner_id = auth.uid() for update;
  if not found then raise exception 'Household owner required' using errcode = '42501'; end if;
  if v_email is null or length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;
  if exists (select 1 from public.household_members m join auth.users u on u.id=m.user_id
    where m.household_id=p_household_id and lower(u.email)=v_email) then
    raise exception 'This person already belongs to your household.' using errcode = '22023';
  end if;
  if exists (select 1 from private.household_invites where household_id=p_household_id
    and invited_email is not null and created_at > now()-interval '60 seconds') then
    raise exception 'Please wait a minute before sending another invitation.' using errcode = '22023';
  end if;
  -- Create only email-bound invitations, atomically under the owner lock.
  v_token := gen_random_uuid()::text;
  delete from private.household_invites where household_id=p_household_id and used_at is null;
  insert into private.household_invites(token_hash,household_id,created_by,invited_email)
    values(sha256(convert_to(v_token,'UTF8')),p_household_id,auth.uid(),v_email);
  return v_token;
end;
$$;
revoke all on function public.create_household_email_invite(uuid,text) from public, anon, authenticated;
grant execute on function public.create_household_email_invite(uuid,text) to authenticated;

create or replace function public.join_household(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_invite private.household_invites; v_household_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
  select household_id into v_household_id from private.household_invites
    where token_hash=sha256(convert_to(lower(btrim(p_code)),'UTF8'));
  if not found then raise exception 'This invitation is invalid or expired. Ask for a new link.' using errcode='22023'; end if;
  perform 1 from public.households where id=v_household_id for update;
  select * into v_invite from private.household_invites
    where token_hash=sha256(convert_to(lower(btrim(p_code)),'UTF8')) for update;
  if not found or v_invite.expires_at <= now() then
    raise exception 'This invitation is invalid or expired. Ask for a new link.' using errcode='22023';
  end if;
  -- Reject even historical consumed unbound tokens; they must not grant access.
  if v_invite.invited_email is null then
    raise exception 'This invitation is invalid or expired. Ask for a new email invitation.' using errcode='22023';
  end if;
  if not exists(
    select 1 from auth.users where id=auth.uid() and lower(email)=v_invite.invited_email and email_confirmed_at is not null
  ) then raise exception 'Sign in with the verified email address this invitation was sent to.' using errcode='42501'; end if;
  if v_invite.used_by=auth.uid() then return v_invite.household_id; end if;
  if v_invite.used_at is not null then raise exception 'This invitation has already been used.' using errcode='22023'; end if;
  if exists(select 1 from public.household_members where household_id=v_invite.household_id and user_id=auth.uid()) then
    raise exception 'You already belong to this household.' using errcode='22023';
  end if;
  insert into public.household_members(household_id,user_id) values(v_invite.household_id,auth.uid());
  update private.household_invites set used_by=auth.uid(),used_at=clock_timestamp() where token_hash=v_invite.token_hash;
  return v_invite.household_id;
end;
$$;

-- Remove the legacy public API, including access through service/browser roles.
drop function public.create_household_invite(uuid);
-- Existing memberships are preserved; unused bearer invitations are invalidated.
delete from private.household_invites where invited_email is null and used_at is null;
