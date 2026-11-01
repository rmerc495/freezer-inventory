begin;
insert into auth.users(id,email,email_confirmed_at) values
('11111111-1111-4111-8111-111111111111','email-owner@example.invalid',now()),
('22222222-2222-4222-8222-222222222222','email-partner@example.invalid',now()),
('33333333-3333-4333-8333-333333333333','email-outsider@example.invalid',now()),
('55555555-5555-4555-8555-555555555555','email-unverified@example.invalid',null);
insert into public.households(id,name,owner_id) values ('44444444-4444-4444-8444-444444444444','Email invitation test','11111111-1111-4111-8111-111111111111');
insert into public.household_members(household_id,user_id) values ('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111');
set local role authenticated;
do $$
declare h uuid := '44444444-4444-4444-8444-444444444444'; token text;
begin
 perform set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
 begin perform public.create_household_email_invite(h,'email-partner@example.invalid'); raise exception 'Expected owner check'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
 begin perform public.create_household_email_invite(h,'bad-email'); raise exception 'Expected email validation'; exception when invalid_parameter_value then null; end;
 token := public.create_household_email_invite(h,' EMAIL-PARTNER@example.invalid ');
 begin perform public.create_household_email_invite(h,'other@example.invalid'); raise exception 'Expected cooldown'; exception when invalid_parameter_value then null; end;
 perform set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
 begin perform public.join_household(token); raise exception 'Expected email binding'; exception when insufficient_privilege then null; end;
 perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
 assert public.join_household(token)=h, 'Verified recipient could not join';
 assert public.join_household(token)=h, 'Join retry failed';
 perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
 begin perform public.create_household_email_invite(h,'email-partner@example.invalid'); raise exception 'Expected existing member check'; exception when invalid_parameter_value then null; end;
end; $$;
reset role;
update private.household_invites set created_at=now()-interval '2 minutes' where household_id='44444444-4444-4444-8444-444444444444';
set local role authenticated;
do $$
declare token text;
begin
 perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
 token := public.create_household_email_invite('44444444-4444-4444-8444-444444444444','email-unverified@example.invalid');
 perform set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',true);
 begin perform public.join_household(token); raise exception 'Expected email verification check'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
set local role anon;
do $$ begin
 begin perform public.create_household_email_invite('44444444-4444-4444-8444-444444444444','any@example.invalid'); raise exception 'Expected anonymous denial'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
rollback;
select 'Email-bound invitation authorization and redemption checks passed; fixtures rolled back.' as result;
