begin;
insert into auth.users(id, email) values
  ('11111111-1111-4111-8111-111111111111', 'invite-owner@example.invalid'),
  ('22222222-2222-4222-8222-222222222222', 'invite-partner@example.invalid'),
  ('33333333-3333-4333-8333-333333333333', 'invite-outsider@example.invalid');
insert into public.households(id, name, owner_id) values
  ('44444444-4444-4444-8444-444444444444', 'Invite test', '11111111-1111-4111-8111-111111111111');
insert into public.household_members(household_id, user_id) values
  ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111');
set local role authenticated;
do $$
declare h uuid := '44444444-4444-4444-8444-444444444444'; old_code text; code text;
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  old_code := public.create_household_invite(h);
  code := public.create_household_invite(h);
  begin
    perform public.join_household(code);
    raise exception 'Expected existing-member rejection';
  exception when invalid_parameter_value then null; end;
  perform set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
  begin
    perform public.create_household_invite(h);
    raise exception 'Expected non-owner rejection';
  exception when insufficient_privilege then null; end;
  begin
    perform public.join_household(old_code);
    raise exception 'Expected replaced-code rejection';
  exception when invalid_parameter_value then null; end;
  begin
    perform count(*) from private.household_invites;
    raise exception 'Expected private invite read rejection';
  exception when insufficient_privilege then null; end;
  assert public.join_household(' ' || upper(code) || ' ') = h, 'join failed';
  assert public.join_household(code) = h, 'join retry failed';
  assert (select count(*) = 2 from public.household_members where household_id = h), 'membership missing';
  perform set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);
  begin
    perform public.join_household(code);
    raise exception 'Expected consumed-code rejection';
  exception when invalid_parameter_value then null; end;
  assert (select count(*) = 0 from public.households), 'outsider became member';
end;
$$;
reset role;
insert into private.household_invites(token_hash, household_id, created_by, expires_at)
values (sha256(convert_to('expired-code', 'UTF8')), '44444444-4444-4444-8444-444444444444',
  '11111111-1111-4111-8111-111111111111', now() - interval '1 day');
set local role authenticated;
do $$
begin
  perform set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);
  begin
    perform public.join_household('expired-code');
    raise exception 'Expected expired-code rejection';
  exception when invalid_parameter_value then null; end;
end;
$$;
reset role;
set local role anon;
do $$
begin
  begin
    perform public.join_household('any-code');
    raise exception 'Expected anonymous rejection';
  exception when insufficient_privilege then null; end;
end;
$$;
reset role;
rollback;
select 'All invitation checks passed; fixtures rolled back.' as result;
