begin;

create table private.household_invites (
  token_hash bytea primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  expires_at timestamptz not null default (now() + interval '7 days'),
  used_by uuid references auth.users(id),
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index household_invites_household_idx on private.household_invites(household_id);
create index household_invites_created_by_idx on private.household_invites(created_by);
create index household_invites_used_by_idx on private.household_invites(used_by);
alter table private.household_invites enable row level security;
revoke all on private.household_invites from public, anon, authenticated;

create function public.create_household_invite(p_household_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_token text := gen_random_uuid()::text;
begin
  perform 1 from public.households where id = p_household_id and owner_id = auth.uid() for update;
  if not found then raise exception 'Household owner required' using errcode = '42501'; end if;
  -- Replacing a code invalidates any previous unused codes.
  delete from private.household_invites where household_id = p_household_id and used_at is null;
  insert into private.household_invites(token_hash, household_id, created_by)
    values (sha256(convert_to(v_token, 'UTF8')), p_household_id, auth.uid());
  return v_token;
end;
$$;

create function public.join_household(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_invite private.household_invites;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
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

revoke all on function public.create_household_invite(uuid), public.join_household(text) from public, anon, authenticated;
grant execute on function public.create_household_invite(uuid), public.join_household(text) to authenticated;
commit;
