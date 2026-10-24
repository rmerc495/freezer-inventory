-- Actual Auth roles; fixtures always roll back.
begin;
insert into auth.users(id, email) values
  ('11111111-1111-4111-8111-111111111111', 'freezer-owner@example.invalid'),
  ('22222222-2222-4222-8222-222222222222', 'freezer-partner@example.invalid'),
  ('33333333-3333-4333-8333-333333333333', 'freezer-outsider@example.invalid');
set local role authenticated;
do $$
declare h uuid; other_h uuid; main uuid; garage uuid := gen_random_uuid(); other_freezer uuid;
  source uuid; target uuid; op uuid; move_op uuid := gen_random_uuid(); undo_id uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  h := public.create_household('Folder Test');
  select id into strict main from public.freezers where household_id=h and is_default;
  assert (select name='Main Freezer' from public.freezers where id=main), 'missing default';
  perform public.add_household_member(h, '22222222-2222-4222-8222-222222222222');
  perform public.save_freezer(h, garage, ' Garage   Freezer ');
  perform public.save_freezer(h, garage, 'Garage Freezer');
  assert (select count(*)=2 from public.freezers where household_id=h), 'create retry duplicated freezer';
  begin
    perform public.save_freezer(h, gen_random_uuid(), 'garage freezer');
    raise exception 'Expected duplicate freezer rejection';
  exception when invalid_parameter_value then null; end;
  perform public.change_inventory(h, gen_random_uuid(), 2, 'peas'); -- old clients default to Main
  perform public.change_inventory(h, gen_random_uuid(), 3, ' PEAS ', p_freezer_id=>garage);
  perform public.change_inventory(h, gen_random_uuid(), 1, 'peas', p_freezer_id=>garage);
  select id into strict source from public.inventory_items where household_id=h and freezer_id=main;
  select id into strict target from public.inventory_items where household_id=h and freezer_id=garage;
  assert source<>target, 'names in different freezers merged';
  assert (select quantity=4 from public.inventory_items where id=target), 'duplicates in freezer did not merge';
  begin
    perform public.change_inventory(h, gen_random_uuid(), 1, p_item_id=>source, p_freezer_id=>garage);
    raise exception 'Expected wrong freezer rejection';
  exception when invalid_parameter_value then null; end;
  perform public.move_inventory(h, move_op, source, garage);
  perform public.move_inventory(h, move_op, source, garage);
  assert (select quantity=0 from public.inventory_items where id=source), 'move did not retain source at zero';
  assert (select quantity=6 from public.inventory_items where id=target), 'move failed to merge or retried twice';
  perform set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
  assert (select count(*)=2 from public.freezers where household_id=h), 'partner cannot see folders';
  perform public.save_freezer(h, garage, 'Basement Freezer');
  perform public.change_inventory(h, gen_random_uuid(), 1, p_item_id=>target, p_freezer_id=>garage);
  begin
    perform public.undo_inventory(h, move_op, gen_random_uuid());
    raise exception 'Expected actor-only move Undo';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
  perform public.undo_inventory(h, move_op, undo_id);
  perform public.undo_inventory(h, move_op, undo_id);
  assert (select quantity=2 from public.inventory_items where id=source), 'Undo move failed at source';
  assert (select quantity=5 from public.inventory_items where id=target), 'Undo move overwrote partner change';
  -- Existing item history remains undoable after assigning its freezer.
  op := gen_random_uuid();
  perform public.change_inventory(h, op, 1, p_item_id=>source);
  perform public.undo_inventory(h, op, gen_random_uuid());
  assert (select quantity=2 from public.inventory_items where id=source), 'ordinary Undo regressed';
  -- An impossible Undo rolls back BOTH sides of a transfer.
  move_op := gen_random_uuid();
  perform public.move_inventory(h, move_op, source, garage);
  perform public.change_inventory(h, gen_random_uuid(), -7, p_item_id=>target);
  begin
    perform public.undo_inventory(h, move_op, gen_random_uuid());
    raise exception 'Expected failed move Undo';
  exception when invalid_parameter_value then null; end;
  assert (select quantity=0 from public.inventory_items where id=source), 'failed Undo partly restored source';
  assert not exists(select 1 from public.inventory_operations where undo_of=move_op), 'failed Undo left history';
  -- Cross-household IDs never authorize freezer changes or moves.
  other_h := public.create_household('Other');
  select id into other_freezer from public.freezers where household_id=other_h;
  begin
    perform public.change_inventory(h, gen_random_uuid(), 1, 'peas', p_freezer_id=>other_freezer);
    raise exception 'Expected foreign freezer rejection';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.save_freezer(h, other_freezer, 'Stolen');
    raise exception 'Expected foreign rename rejection';
  exception when insufficient_privilege then null; end;
  begin
    perform public.move_inventory(h, gen_random_uuid(), target, other_freezer);
    raise exception 'Expected foreign destination rejection';
  exception when invalid_parameter_value then null; end;
  begin
    update public.freezers set name='Direct write' where id=garage;
    raise exception 'Expected direct-write rejection';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);
  assert not exists(select 1 from public.freezers where household_id=h), 'outsider can read folders';
  begin
    perform public.save_freezer(h, gen_random_uuid(), 'Intruder');
    raise exception 'Expected outsider rejection';
  exception when insufficient_privilege then null; end;
end;
$$;
set local role anon;
do $$ begin
  begin
    perform public.save_freezer(gen_random_uuid(), gen_random_uuid(), 'Anonymous');
    raise exception 'Expected anonymous rejection';
  exception when insufficient_privilege then null; end;
end; $$;
rollback;
select 'All freezer-folder, transfer, Undo, and access checks passed; fixtures rolled back.' as result;
