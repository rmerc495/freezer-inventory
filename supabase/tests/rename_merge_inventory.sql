begin;
insert into auth.users(id,email) values
 ('11111111-1111-4111-8111-111111111111','rename-owner@example.invalid'),
 ('22222222-2222-4222-8222-222222222222','rename-partner@example.invalid'),
 ('33333333-3333-4333-8333-333333333333','rename-outsider@example.invalid');
set local role authenticated;
do $$
declare h uuid; f uuid; f2 uuid:=gen_random_uuid(); source uuid; target uuid; batch uuid:=gen_random_uuid();
  request_id uuid:=gen_random_uuid(); result jsonb; retry jsonb; op uuid; zero_id uuid;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
  h:=public.create_household('Rename Test');
  perform public.add_household_member(h,'22222222-2222-4222-8222-222222222222');
  select id into f from public.freezers where household_id=h and is_default;
  perform public.save_freezer(h,f2,'Other Freezer');
  perform public.bulk_add_inventory(h,batch,f,'[{"name":"popscicles","quantity":2},{"name":"popsicles","quantity":3}]');
  select id into source from public.inventory_items where household_id=h and name='Popscicles';
  select id into target from public.inventory_items where household_id=h and name='Popsicles';
  -- A matching record requires explicit confirmation; no silent merge.
  begin
    perform public.rename_inventory_item(h,request_id,source,'Popscicles','popsicles');
    raise exception 'Expected merge confirmation';
  exception when invalid_parameter_value then null; end;
  assert (select quantity=2 from public.inventory_items where id=source), 'rejected merge changed stock';
  result:=public.rename_inventory_item(h,request_id,source,'Popscicles','popsicles',target);
  retry:=public.rename_inventory_item(h,request_id,source,'Popscicles',' POPSICLES ',target);
  assert result=retry, 'retry result changed';
  assert not exists(select 1 from public.inventory_items where id=source), 'misspelled suggestion survived';
  assert (select quantity=5 from public.inventory_items where id=target), 'merge quantity or retry wrong';
  assert (select count(*)=1 from public.inventory_changes where operation_id=batch), 'batch histories not consolidated';
  assert (select delta=5 from public.inventory_changes where operation_id=batch), 'merge lost history delta';
  begin
    perform public.rename_inventory_item(h,request_id,target,'Popsicles','pops');
    raise exception 'Expected request fingerprint rejection';
  exception when invalid_parameter_value then null; end;
  perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
  begin
    perform public.rename_inventory_item(h,request_id,source,'Popscicles','popsicles',target);
    raise exception 'Expected actor mismatch rejection';
  exception when invalid_parameter_value then null; end;
  perform public.change_inventory(h,gen_random_uuid(),2,p_item_id=>target,p_freezer_id=>f);
  perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
  perform public.undo_inventory(h,batch,gen_random_uuid());
  assert (select quantity=2 from public.inventory_items where id=target), 'Undo lost partner stock';

  -- Plain rename preserves the ID and zero-stock suggestions without adding stock.
  op:=gen_random_uuid();
  perform public.change_inventory(h,op,1,'chikcen',p_freezer_id=>f);
  select id into zero_id from public.inventory_items where household_id=h and name='Chikcen';
  perform public.change_inventory(h,gen_random_uuid(),-1,p_item_id=>zero_id,p_freezer_id=>f);
  perform public.change_inventory(h,gen_random_uuid(),1,'chicken',p_freezer_id=>f2);
  result:=public.rename_inventory_item(h,gen_random_uuid(),zero_id,'Chikcen',' chicken ');
  assert not (result->>'merged')::boolean, 'merged across freezers';
  assert (select name='Chicken' and quantity=0 from public.inventory_items where id=zero_id), 'zero-stock rename failed';
  assert (select count(*)=2 from public.inventory_items where household_id=h and name='Chicken'), 'other freezer changed';
  begin
    perform public.rename_inventory_item(h,gen_random_uuid(),zero_id,'Chikcen','Turkey');
    raise exception 'Expected stale name rejection';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.rename_inventory_item(h,gen_random_uuid(),zero_id,'Chicken','   ');
    raise exception 'Expected empty name rejection';
  exception when invalid_parameter_value then null; end;
  -- Overflow must leave both records intact.
  perform public.change_inventory(h,gen_random_uuid(),2147483647,'Huge',p_freezer_id=>f);
  select id into source from public.inventory_items where household_id=h and name='Huge';
  begin
    perform public.rename_inventory_item(h,gen_random_uuid(),target,'Popsicles','Huge',source);
    raise exception 'Expected overflow rejection';
  exception when invalid_parameter_value then null; end;
  assert (select quantity=2 from public.inventory_items where id=target), 'overflow partially merged';
  -- Outsiders and anonymous callers cannot correct another household.
  perform set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
  begin
    perform public.rename_inventory_item(h,gen_random_uuid(),target,'Popsicles','stolen');
    raise exception 'Expected outsider rejection';
  exception when insufficient_privilege then null; end;
end;
$$;
reset role;
set local role anon;
do $$ begin
  perform public.rename_inventory_item(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'x','y');
  raise exception 'Expected anonymous rejection';
exception when insufficient_privilege then null; end; $$;
reset role;
rollback;
