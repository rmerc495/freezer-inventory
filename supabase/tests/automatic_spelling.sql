begin;
insert into auth.users(id,email) values
 ('11111111-1111-4111-8111-111111111111','spelling-owner@example.invalid'),
 ('22222222-2222-4222-8222-222222222222','spelling-partner@example.invalid'),
 ('33333333-3333-4333-8333-333333333333','spelling-outsider@example.invalid');
update private.item_enrichment set next_attempt_at=now()+interval '1 day';
do $$
declare h uuid; f uuid; op uuid:=gen_random_uuid(); op2 uuid; ai_op uuid; ai_op2 uuid; token uuid; original uuid;
  original_time timestamptz; candidate text; pending_name text; source_id uuid;
begin
  assert private.spelling_difference('peperoni','pepperoni')='repeat', 'missing repeated letter not found';
  assert private.spelling_difference('chikcen','chicken')='transpose', 'transposition not found';
  assert private.spelling_difference('chicken thighs','chicken wings') is null, 'different food matched';
  assert private.spelling_difference('tuna','tuba') is null, 'short name matched';
  assert private.spelling_difference('7up','7upp') is null, 'numeric brand matched';
  perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
  h:=public.create_household('Spelling Test');
  perform public.add_household_member(h,'22222222-2222-4222-8222-222222222222');
  select id into f from public.freezers where household_id=h and is_default;
  perform public.change_inventory(h,gen_random_uuid(),2,'pepperoni');
  perform public.submit_inventory_item(h,op,f,'peperoni',3);
  perform public.submit_inventory_item(h,op,f,' PEPERONI ',3);
  assert (select quantity=5 from public.inventory_items where household_id=h and name='Pepperoni'), 'local correction/retry failed';
  assert not exists(select 1 from public.inventory_items where household_id=h and name='Peperoni'), 'local typo stored';
  assert (select status='corrected' from public.inventory_spelling where operation_id=op), 'notice missing';
  begin
    perform public.submit_inventory_item(h,op,f,'peperoni',4); raise exception 'Expected retry mismatch';
  exception when invalid_parameter_value then null; end;
  perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
  begin
    perform public.restore_inventory_spelling(h,op); raise exception 'Expected actor denial';
  exception when insufficient_privilege then null; end;
  perform public.change_inventory(h,gen_random_uuid(),1,'pepperoni');
  perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
  perform public.restore_inventory_spelling(h,op);
  perform public.restore_inventory_spelling(h,op);
  assert (select quantity=3 from public.inventory_items where household_id=h and name='Pepperoni'), 'restore changed partner stock';
  assert (select quantity=3 from public.inventory_items where household_id=h and name='Peperoni'), 'restore did not split entry';
  op2:=gen_random_uuid();
  perform public.submit_inventory_item(h,op2,f,'peperoni',1);
  assert (select quantity=4 from public.inventory_items where household_id=h and name='Peperoni'), 'opt out not remembered';
  perform public.undo_inventory(h,op,gen_random_uuid());
  assert (select quantity=1 from public.inventory_items where household_id=h and name='Peperoni'), 'quantity Undo did not follow restored entry';

  -- An unfamiliar typo saves immediately. The same enrichment response fixes
  -- spelling and supplies canonical-name metadata without another queued call.
  ai_op:=gen_random_uuid(); ai_op2:=gen_random_uuid();
  perform public.submit_inventory_item(h,ai_op,f,'brocoli',2);
  perform public.submit_inventory_item(h,ai_op2,f,'brocoli',1);
  select id,updated_at into original,original_time from public.inventory_items where household_id=h and name='Brocoli';
  assert (select quantity=3 from public.inventory_items where id=original), 'save waited for AI';
  -- Exclude unrelated fixtures from this deterministic claim.
  update private.item_enrichment set next_attempt_at=now()+interval '1 day' where household_id=h;
  update private.item_enrichment set next_attempt_at=now()-interval '1 second' where household_id=h and normalized_name='brocoli';
  select lease_token into token from public.claim_item_enrichment();
  perform public.finish_item_enrichment_with_spelling(h,'brocoli',token,array['vegetables'],'{}','gpt-5-nano',p_corrected_name=>'broccoli');
  assert not exists(select 1 from public.inventory_items where id=original), 'background typo left in suggestions';
  assert (select quantity=3 and tags=array['vegetables'] from public.inventory_items where household_id=h and name='Broccoli'), 'AI correction or metadata failed';
  assert (select status='ready' and spelling_checked from private.item_enrichment where household_id=h and normalized_name='broccoli'), 'canonical name queued extra AI call';
  assert (select count(*)=2 from public.inventory_spelling where operation_id in(ai_op,ai_op2) and status='corrected'), 'pending entries not corrected together';
  perform public.restore_inventory_spelling(h,ai_op);
  assert (select quantity=2 from public.inventory_items where household_id=h and name='Brocoli'), 'AI correction restoration failed';
  assert (select quantity=1 from public.inventory_items where household_id=h and name='Broccoli'), 'AI restore moved another addition';

  -- Valid names, ingredients and changed stock are protected from AI guesses.
  op2:=gen_random_uuid();
  perform public.submit_inventory_item(h,op2,f,'chicken thighs',1);
  update private.item_enrichment set next_attempt_at=now()-interval '1 second' where household_id=h and normalized_name='chicken thighs';
  select lease_token into token from public.claim_item_enrichment();
  perform public.finish_item_enrichment_with_spelling(h,'chicken thighs',token,'{}','{}','gpt-5-nano',p_corrected_name=>'chicken wings');
  assert exists(select 1 from public.inventory_items where household_id=h and name='Chicken Thighs'), 'AI changed food identity';
  op2:=gen_random_uuid();
  perform public.submit_inventory_item(h,op2,f,'carots',2);
  select id into source_id from public.inventory_items where household_id=h and name='Carots';
  perform public.change_inventory(h,gen_random_uuid(),-1,p_item_id=>source_id,p_freezer_id=>f);
  update private.item_enrichment set next_attempt_at=now()-interval '1 second' where household_id=h and normalized_name='carots';
  select lease_token into token from public.claim_item_enrichment();
  perform public.finish_item_enrichment_with_spelling(h,'carots',token,array['vegetables'],'{}','gpt-5-nano',p_corrected_name=>'carrots');
  assert (select name='Carots' and quantity=1 from public.inventory_items where id=source_id), 'AI changed stock after an edit';

  -- Existing zero-stock suggestions are trusted; no correction on restocking.
  perform public.change_inventory(h,gen_random_uuid(),1,'Tillamook');
  select id into source_id from public.inventory_items where household_id=h and name='Tillamook';
  perform public.change_inventory(h,gen_random_uuid(),-1,p_item_id=>source_id,p_freezer_id=>f);
  op2:=gen_random_uuid(); perform public.submit_inventory_item(h,op2,f,'Tillamook',1);
  assert (select status='unchanged' from public.inventory_spelling where operation_id=op2), 'saved brand not trusted';

  -- Actual roles cannot forge notices, call the worker, or see partner entries.
  set local role authenticated;
  assert (select count(*)>=1 from public.inventory_spelling where household_id=h), 'owner cannot read own notices';
  perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
  assert not exists(select 1 from public.inventory_spelling where operation_id=ai_op), 'partner read private notice';
  begin
    perform public.finish_item_enrichment_with_spelling(h,'x',gen_random_uuid()); raise exception 'Expected worker denial';
  exception when insufficient_privilege then null; end;
  begin
    update public.inventory_spelling set status='corrected' where operation_id=ai_op; raise exception 'Expected direct write denial';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
  begin
    perform public.submit_inventory_item(h,gen_random_uuid(),f,'peas',1); raise exception 'Expected outsider denial';
  exception when insufficient_privilege then null; end;
  reset role;
end;
$$;
rollback;
