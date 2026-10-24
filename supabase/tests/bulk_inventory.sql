begin;
insert into auth.users(id,email) values
 ('11111111-1111-4111-8111-111111111111','bulk-owner@example.invalid'),
 ('22222222-2222-4222-8222-222222222222','bulk-partner@example.invalid'),
 ('33333333-3333-4333-8333-333333333333','bulk-outsider@example.invalid');
set local role authenticated;
do $$
declare h uuid; f uuid; other_h uuid; other_f uuid; second_f uuid := gen_random_uuid();
  op uuid := gen_random_uuid(); bad_op uuid; undo_id uuid := gen_random_uuid(); item uuid;
  payload jsonb := '[{"name":" chicken   THIGHS ","quantity":2},{"name":"CHICKEN THIGHS","quantity":3},{"name":"peas","quantity":1}]';
  invalid jsonb;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
  h := public.create_household('Bulk Test');
  select id into strict f from public.freezers where household_id=h and is_default;
  perform public.add_household_member(h,'22222222-2222-4222-8222-222222222222');
  perform public.change_inventory(h,gen_random_uuid(),1,'peas',p_freezer_id=>f);
  perform public.bulk_add_inventory(h,op,f,payload);
  perform public.bulk_add_inventory(h,op,f,'[{"name":"Peas","quantity":1},{"name":"chicken thighs","quantity":5}]');
  assert (select count(*)=2 from public.inventory_items where household_id=h), 'bulk duplicate or retry failed';
  assert (select quantity=5 and name='Chicken Thighs' from public.inventory_items where household_id=h and normalized_name='chicken thighs'), 'bulk normalization failed';
  assert (select quantity=2 from public.inventory_items where household_id=h and normalized_name='peas'), 'bulk add to existing failed';
  assert (select count(*)=2 from public.inventory_changes where operation_id=op), 'batch must have one change per combined name';
  assert (select count(distinct updated_at)=1 from public.inventory_items where household_id=h), 'batch timestamps differ';
  begin
    perform public.bulk_add_inventory(h,op,f,'[{"name":"peas","quantity":2}]');
    raise exception 'Expected changed request rejection';
  exception when invalid_parameter_value then null; end;
  perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
  perform public.bulk_add_inventory(h,gen_random_uuid(),f,'[{"name":"peas","quantity":2}]');
  begin
    perform public.undo_inventory(h,op,gen_random_uuid());
    raise exception 'Expected actor-only batch Undo';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
  perform public.undo_inventory(h,op,undo_id);
  perform public.undo_inventory(h,op,undo_id);
  assert (select quantity=0 from public.inventory_items where household_id=h and normalized_name='chicken thighs'), 'batch Undo failed to hide new item';
  assert (select quantity=3 from public.inventory_items where household_id=h and normalized_name='peas'), 'batch Undo lost later partner stock';
  -- Same names in separate freezers remain separate.
  perform public.save_freezer(h,second_f,'Garage');
  perform public.bulk_add_inventory(h,gen_random_uuid(),second_f,'[{"name":"peas","quantity":7}]');
  assert (select quantity=7 from public.inventory_items where freezer_id=second_f), 'wrong freezer in bulk';
  -- Every invalid payload is rejected without history or partial writes.
  for invalid in select value from jsonb_array_elements('[null,{},[],[null],[{"name":"peas","quantity":0}],[{"name":"peas","quantity":-1}],[{"name":"peas","quantity":1.5}],[{"name":"peas","quantity":"2"}],[{"name":"peas","quantity":2147483648}],[{"name":"  ","quantity":1}],[{"name":"peas"}],[{"quantity":1}]]') loop
    bad_op := gen_random_uuid();
    begin
      perform public.bulk_add_inventory(h,bad_op,f,invalid);
      raise exception 'Expected invalid payload rejection: %', invalid;
    exception when invalid_parameter_value then null; end;
    assert not exists(select 1 from public.inventory_operations where id=bad_op), 'invalid batch left history';
  end loop;
  begin
    perform public.bulk_add_inventory(h,gen_random_uuid(),f,(select jsonb_agg(jsonb_build_object('name','peas','quantity',1)) from generate_series(1,101)));
    raise exception 'Expected batch limit rejection';
  exception when invalid_parameter_value then null; end;
  -- Overflow after an alphabetically earlier item must roll back the earlier write too.
  bad_op := gen_random_uuid();
  begin
    perform public.bulk_add_inventory(h,bad_op,f,'[{"name":"apples","quantity":1},{"name":"peas","quantity":2147483647}]');
    raise exception 'Expected existing stock overflow';
  exception when invalid_parameter_value then null; end;
  assert not exists(select 1 from public.inventory_items where household_id=h and normalized_name='apples'), 'batch partly applied';
  assert not exists(select 1 from public.inventory_operations where id=bad_op), 'failed batch left history';
  begin
    perform public.bulk_add_inventory(h,gen_random_uuid(),f,'[{"name":"pizza","quantity":2147483647},{"name":"PIZZA","quantity":1}]');
    raise exception 'Expected combined quantity overflow';
  exception when invalid_parameter_value then null; end;
  -- Failed batch Undo must reverse neither item, regardless of lock order.
  op := gen_random_uuid();
  perform public.bulk_add_inventory(h,op,f,'[{"name":"apples","quantity":2},{"name":"peaches","quantity":2}]');
  select id into item from public.inventory_items where freezer_id=f and normalized_name='peaches';
  perform public.change_inventory(h,gen_random_uuid(),-2,p_item_id=>item,p_freezer_id=>f);
  begin
    perform public.undo_inventory(h,op,gen_random_uuid());
    raise exception 'Expected impossible batch Undo rejection';
  exception when invalid_parameter_value then null; end;
  assert (select quantity=2 from public.inventory_items where freezer_id=f and normalized_name='apples'), 'failed Undo changed another batch item';
  assert not exists(select 1 from public.inventory_operations where undo_of=op), 'failed Undo left history';
  other_h := public.create_household('Other Household');
  select id into other_f from public.freezers where household_id=other_h;
  begin
    perform public.bulk_add_inventory(h,gen_random_uuid(),other_f,payload);
    raise exception 'Expected foreign freezer rejection';
  exception when invalid_parameter_value then null; end;
  perform set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
  begin
    perform public.bulk_add_inventory(h,gen_random_uuid(),f,payload);
    raise exception 'Expected outsider rejection';
  exception when insufficient_privilege then null; end;
end;
$$;
set local role anon;
do $$ begin
  begin
    perform public.bulk_add_inventory(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'[{"name":"peas","quantity":1}]');
    raise exception 'Expected anonymous rejection';
  exception when insufficient_privilege then null; end;
end; $$;
rollback;
select 'All bulk entry, duplicate, retry, Undo, rollback, and access checks passed; fixtures rolled back.' as result;
