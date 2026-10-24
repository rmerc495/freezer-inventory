-- Run with: npx.cmd --yes supabase db query --linked --file supabase/tests/inventory_foundation.sql
-- Real authenticated/anonymous database roles; all fixtures are rolled back.
begin;
insert into auth.users(id, email) values
  ('11111111-1111-4111-8111-111111111111', 'schema-test-owner@example.invalid'),
  ('22222222-2222-4222-8222-222222222222', 'schema-test-partner@example.invalid'),
  ('33333333-3333-4333-8333-333333333333', 'schema-test-outsider@example.invalid');
set local role authenticated;
do $$
declare
  h uuid; other_h uuid; item uuid; op uuid := gen_random_uuid();
  removal uuid := gen_random_uuid(); undo_id uuid := gen_random_uuid();
  later_add uuid := gen_random_uuid(); q integer; n integer;
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  h := public.create_household('Schema Test');
  perform public.add_household_member(h, '22222222-2222-4222-8222-222222222222');
  perform public.change_inventory(h, op, 2, '  chicken   THIGHS ');
  perform public.change_inventory(h, op, 2, 'Chicken Thighs'); -- retry must not add twice
  perform public.change_inventory(h, gen_random_uuid(), 1, E'CHICKEN\tthighs');
  select id, quantity into item, q from public.inventory_items where household_id = h;
  assert q = 3, 'duplicate adds or retry failed';
  assert (select name = 'Chicken Thighs' from public.inventory_items where id = item), 'title case failed';
  assert (select count(*) = 1 from public.inventory_items where household_id = h), 'duplicate row';
  begin
    perform public.change_inventory(h, op, 7, 'Chicken Thighs');
    raise exception 'Expected reused request rejection';
  exception when invalid_parameter_value then null;
  end;
  begin
    update public.inventory_items set quantity = 500 where id = item;
    raise exception 'Expected direct write rejection';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.change_inventory(h, gen_random_uuid(), -4, p_item_id => item);
    raise exception 'Expected negative quantity rejection';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.change_inventory(h, gen_random_uuid(), 2147483647, p_item_id => item);
    raise exception 'Expected overflow rejection';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.change_inventory(h, gen_random_uuid(), 1, E' \t ');
    raise exception 'Expected blank name rejection';
  exception when invalid_parameter_value then null;
  end;
  perform public.change_inventory(h, removal, -3, p_item_id => item);
  assert (select quantity = 0 from public.inventory_items where id = item), 'zero item not preserved';
  assert (select count(*) = 0 from public.inventory_items where household_id = h and quantity > 0), 'active filter failed';
  -- Partner can see and restock the same row.
  perform set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
  perform public.change_inventory(h, later_add, 2, 'Chicken Thighs');
  begin
    perform public.add_household_member(h, '33333333-3333-4333-8333-333333333333');
    raise exception 'Expected nonowner membership rejection';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.undo_inventory(h, removal, gen_random_uuid());
    raise exception 'Expected other actor undo rejection';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform public.undo_inventory(h, removal, undo_id);
  perform public.undo_inventory(h, removal, undo_id); -- retry
  assert (select quantity = 5 from public.inventory_items where id = item), 'undo overwrote partner change';
  begin
    perform public.undo_inventory(h, removal, gen_random_uuid());
    raise exception 'Expected second undo rejection';
  exception when invalid_parameter_value then null;
  end;
  -- Consume stock; undo of a prior addition must never create negative stock.
  perform public.change_inventory(h, gen_random_uuid(), -5, p_item_id => item);
  select count(*) into n from public.inventory_operations where household_id = h;
  begin
    perform public.undo_inventory(h, op, gen_random_uuid());
    raise exception 'Expected unavailable stock rejection';
  exception when invalid_parameter_value then null;
  end;
  assert (select count(*) = n from public.inventory_operations where household_id = h), 'failed undo left history';
  -- A signed-in stranger cannot read any household data or call its write RPCs.
  perform set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);
  assert (select count(*) = 0 from public.households), 'household leak';
  assert (select count(*) = 0 from public.household_members), 'membership leak';
  assert (select count(*) = 0 from public.inventory_items), 'item leak';
  assert (select count(*) = 0 from public.inventory_operations), 'operation leak';
  assert (select count(*) = 0 from public.inventory_changes), 'change leak';
  begin
    perform public.change_inventory(h, gen_random_uuid(), 1, 'Pizza');
    raise exception 'Expected outsider write rejection';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.undo_inventory(h, op, gen_random_uuid());
    raise exception 'Expected outsider undo rejection';
  exception when insufficient_privilege then null;
  end;
  other_h := public.create_household('Other Test Household');
  begin
    perform public.change_inventory(other_h, gen_random_uuid(), 1, p_item_id => item);
    raise exception 'Expected cross-household item rejection';
  exception when invalid_parameter_value then null;
  end;
end;
$$;
reset role;
set local role anon;
do $$
begin
  begin
    perform count(*) from public.inventory_items;
    raise exception 'Expected anonymous read rejection';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.create_household('Anonymous');
    raise exception 'Expected anonymous RPC rejection';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
rollback;
select 'All inventory and access-control checks passed; fixtures rolled back.' as result;
