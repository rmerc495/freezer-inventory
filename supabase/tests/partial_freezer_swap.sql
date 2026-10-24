begin;
insert into auth.users(id,email) values
 ('11111111-1111-4111-8111-111111111111','swap-owner@example.invalid'),
 ('22222222-2222-4222-8222-222222222222','swap-partner@example.invalid');
set local role authenticated;
do $$
declare h uuid; main uuid; inside uuid := gen_random_uuid(); source uuid; target uuid;
  op uuid := gen_random_uuid(); undo_id uuid := gen_random_uuid(); bad uuid; amount integer;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
  h := public.create_household('Swap Test');
  select id into main from public.freezers where household_id=h and is_default;
  perform public.save_freezer(h,inside,'Inside Freezer');
  perform public.add_household_member(h,'22222222-2222-4222-8222-222222222222');
  perform public.change_inventory(h,gen_random_uuid(),6,'chicken thighs',p_freezer_id=>main);
  perform public.change_inventory(h,gen_random_uuid(),1,'Chicken Thighs',p_freezer_id=>inside);
  select id into source from public.inventory_items where freezer_id=main;
  select id into target from public.inventory_items where freezer_id=inside;
  perform public.move_inventory(h,op,source,inside,2);
  perform public.move_inventory(h,op,source,inside,2);
  assert (select quantity=4 from public.inventory_items where id=source), 'partial source or retry wrong';
  assert (select quantity=3 from public.inventory_items where id=target), 'partial combining wrong';
  assert (select count(*)=2 from public.inventory_changes where operation_id=op), 'swap history wrong';
  begin
    perform public.move_inventory(h,op,source,inside,3);
    raise exception 'Expected retry quantity mismatch';
  exception when invalid_parameter_value then null; end;
  perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
  perform public.change_inventory(h,gen_random_uuid(),1,p_item_id=>source);
  perform public.change_inventory(h,gen_random_uuid(),1,p_item_id=>target);
  begin
    perform public.undo_inventory(h,op,gen_random_uuid());
    raise exception 'Expected actor-only Undo';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
  perform public.undo_inventory(h,op,undo_id);
  perform public.undo_inventory(h,op,undo_id);
  assert (select quantity=7 from public.inventory_items where id=source), 'Undo did not preserve later source add';
  assert (select quantity=2 from public.inventory_items where id=target), 'Undo did not preserve later destination add';
  foreach amount in array array[0,-1,8] loop
    bad := gen_random_uuid();
    begin
      perform public.move_inventory(h,bad,source,inside,amount);
      raise exception 'Expected invalid swap quantity';
    exception when invalid_parameter_value then null; end;
    assert not exists(select 1 from public.inventory_operations where id=bad), 'invalid swap history saved';
    assert (select quantity=7 from public.inventory_items where id=source), 'invalid swap changed source';
  end loop;
  -- Source availability is checked against the current locked row.
  perform public.change_inventory(h,gen_random_uuid(),-5,p_item_id=>source);
  begin
    perform public.move_inventory(h,gen_random_uuid(),source,inside,3);
    raise exception 'Expected changed-stock rejection';
  exception when invalid_parameter_value then null; end;
  op := gen_random_uuid();
  perform public.move_inventory(h,op,source,inside,2);
  perform public.move_inventory(h,op,source,inside,2); -- retry must work when source is zero
  assert (select quantity=0 from public.inventory_items where id=source), 'full remainder not hidden';
  -- Failed Undo reverses neither side.
  perform public.change_inventory(h,gen_random_uuid(),-4,p_item_id=>target);
  begin
    perform public.undo_inventory(h,op,gen_random_uuid());
    raise exception 'Expected impossible swap Undo rejection';
  exception when invalid_parameter_value then null; end;
  assert (select quantity=0 from public.inventory_items where id=source), 'failed swap Undo partially applied';
  assert not exists(select 1 from public.inventory_operations where undo_of=op), 'failed Undo history left';
  -- Legacy all-stock callers and their old fingerprints are still supported.
  perform public.change_inventory(h,gen_random_uuid(),3,p_item_id=>source);
  op := gen_random_uuid();
  perform public.move_inventory(h,op,source,inside);
  perform public.move_inventory(h,op,source,inside);
  assert (select quantity=3 from public.inventory_items where id=target), 'legacy swap regression';
end;
$$;
rollback;
select 'Partial freezer swaps, combining, retries, quantities, and Undo passed; fixtures rolled back.' as result;
