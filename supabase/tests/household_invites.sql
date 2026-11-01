begin;
insert into auth.users(id, email, email_confirmed_at) values
  ('11111111-1111-4111-8111-111111111111', 'invite-owner@example.invalid', now()),
  ('22222222-2222-4222-8222-222222222222', 'invite-partner@example.invalid', now()),
  ('33333333-3333-4333-8333-333333333333', 'invite-outsider@example.invalid', now());
insert into public.households(id, name, owner_id) values
  ('44444444-4444-4444-8444-444444444444', 'Invite test', '11111111-1111-4111-8111-111111111111');
insert into public.household_members(household_id, user_id) values
  ('44444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111');
-- Keep a legacy unbound token as a regression fixture even after migration cleanup.
insert into private.household_invites(token_hash,household_id,created_by)
values(sha256(convert_to('legacy-code','UTF8')),'44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111');
set local role authenticated;
do $$
declare h uuid := '44444444-4444-4444-8444-444444444444'; code text;
begin
  assert to_regprocedure('public.create_household_invite(uuid)') is null, 'Legacy issuance API still exists';
  perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
  code := public.create_household_email_invite(h,'invite-partner@example.invalid');
  perform set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
  begin
    perform public.join_household('legacy-code');
    raise exception 'Legacy token accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.join_household(code);
    raise exception 'Wrong recipient accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform count(*) from private.household_invites;
    raise exception 'Private invitation table exposed';
  exception when insufficient_privilege then null; end;
  assert (select count(*)=0 from public.households), 'Outsider gained access';
  perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
  assert public.join_household(' ' || upper(code) || ' ')=h, 'Verified recipient rejected';
  assert public.join_household(code)=h, 'Retry rejected';
end;
$$;
reset role;
-- A previously consumed unbound token must also be rejected, even for its redeemer.
insert into private.household_invites(token_hash,household_id,created_by,used_by,used_at)
values(sha256(convert_to('used-legacy-code','UTF8')),'44444444-4444-4444-8444-444444444444',
'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',now());
set local role authenticated;
do $$ begin
  perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
  begin perform public.join_household('used-legacy-code'); raise exception 'Consumed legacy token accepted';
  exception when invalid_parameter_value then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin perform public.join_household('any-code'); raise exception 'Anonymous redemption accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
select 'Email-only invitation regression checks passed; fixtures rolled back.' as result;
