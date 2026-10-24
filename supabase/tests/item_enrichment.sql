-- Transactional fixtures; no AI requests and no persistent stock changes.
begin;
insert into auth.users(id,email) values
 ('11111111-1111-4111-8111-111111111111','enrichment-owner@example.invalid'),
 ('33333333-3333-4333-8333-333333333333','enrichment-outsider@example.invalid');
-- Keep real jobs out of this test's worker batch; rolled back below.
update private.item_enrichment set next_attempt_at = now() + interval '1 day';
do $$
declare h uuid; f uuid; second_f uuid := gen_random_uuid(); other_h uuid; item uuid;
  job record; token uuid; old_token uuid; stock_time timestamptz; history_count bigint;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
  h := public.create_household('Enrichment Test');
  select id into strict f from public.freezers where household_id=h and is_default;
  perform public.change_inventory(h,gen_random_uuid(),2,'Broccoli',p_freezer_id=>f);
  perform public.change_inventory(h,gen_random_uuid(),1,' BROCCOLI ',p_freezer_id=>f);
  assert (select count(*)=1 from private.item_enrichment where household_id=h), 'duplicate cache entries';
  select id, updated_at into item, stock_time from public.inventory_items where household_id=h;
  assert (select quantity=3 and tags='{}' from public.inventory_items where id=item), 'saving waited on metadata';
  select count(*) into history_count from public.inventory_operations where household_id=h;

  set local role service_role;
  select * into strict job from public.claim_item_enrichment();
  reset role;
  token := job.lease_token; old_token := token;
  assert job.household_id=h and job.normalized_name='broccoli', 'wrong claim';
  assert not exists (select 1 from public.claim_item_enrichment()), 'active job claimed twice';
  assert not public.finish_item_enrichment(h,'broccoli',gen_random_uuid(),array['wrong'],'{}','test'), 'stale token accepted';
  perform public.finish_item_enrichment(h,'broccoli',token,p_error=>'openai_http_429');
  assert (select status='pending' and attempts=1 and next_attempt_at>now() from private.item_enrichment where household_id=h), 'retry missing backoff';
  assert not exists (select 1 from public.claim_item_enrichment()), 'backoff bypassed';
  update private.item_enrichment set next_attempt_at=now()-interval '1 second' where household_id=h;
  select lease_token into token from public.claim_item_enrichment();
  assert token<>old_token, 'lease not renewed';
  assert not public.finish_item_enrichment(h,'broccoli',old_token,p_error=>'late_failure'), 'old failure overwrote new lease';
  begin
    perform public.finish_item_enrichment(h,'broccoli',token,array[repeat('x',41)],'{}','test');
    raise exception 'Expected invalid metadata rejection';
  exception when invalid_parameter_value then null; end;
  perform public.finish_item_enrichment(h,'broccoli',token,array['vegetables'],array['broccoli florets'],'gpt-5-nano');
  assert (select tags=array['vegetables'] and quantity=3 and updated_at=stock_time from public.inventory_items where id=item), 'metadata changed stock or ordering';
  assert (select count(*)=history_count from public.inventory_operations where household_id=h), 'metadata changed Undo history';
  perform public.save_freezer(h,second_f,'Other Freezer');
  perform public.move_inventory(h,gen_random_uuid(),item,second_f,1);
  assert (select tags=array['vegetables'] from public.inventory_items where household_id=h and freezer_id=second_f), 'move did not reuse cache';
  perform public.change_inventory(h,gen_random_uuid(),-2,p_item_id=>item,p_freezer_id=>f);
  perform public.change_inventory(h,gen_random_uuid(),1,'broccoli',p_freezer_id=>f);
  assert (select tags=array['vegetables'] from public.inventory_items where id=item), 'restock lost cache';
  assert (select attempts=2 and status='ready' from private.item_enrichment where household_id=h), 'restock called AI again';

  -- Same name in another household must have its own private queue/cache.
  other_h := public.create_household('Other Household');
  perform public.change_inventory(other_h,gen_random_uuid(),1,'broccoli');
  assert (select tags='{}' from public.inventory_items where household_id=other_h), 'cache crossed household boundary';
  select lease_token into token from public.claim_item_enrichment();
  update private.item_enrichment set attempts=6 where household_id=other_h;
  perform public.finish_item_enrichment(other_h,'broccoli',token,p_error=>'openai_http_500');
  assert (select status='failed' from private.item_enrichment where household_id=other_h), 'unbounded paid retries';
  assert not exists(select 1 from public.claim_item_enrichment()), 'failed job reclaimed';

  -- A terminated invocation is recoverable without accepting its late output.
  update private.item_enrichment set status='processing', attempts=1,
    lease_token=gen_random_uuid(), next_attempt_at=now()-interval '1 second'
    where household_id=other_h returning lease_token into old_token;
  select lease_token into token from public.claim_item_enrichment();
  assert token is not null and token<>old_token, 'expired lease was not recovered';
  assert not public.finish_item_enrichment(other_h,'broccoli',old_token,p_error=>'late'), 'expired lease accepted';
  update private.item_enrichment set attempts=6, next_attempt_at=now()-interval '1 second' where household_id=other_h;
  assert not exists(select 1 from public.claim_item_enrichment()), 'sixth crashed attempt retried';
  assert (select status='failed' from private.item_enrichment where household_id=other_h), 'sixth crashed attempt not retired';

  set local role authenticated;
  assert (select tags=array['vegetables'] from public.inventory_items where id=item), 'member cannot read tags';
  begin
    perform public.claim_item_enrichment(); raise exception 'Expected worker denial';
  exception when insufficient_privilege then null; end;
  begin
    perform public.finish_item_enrichment(h,'broccoli',token); raise exception 'Expected metadata write denial';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from private.item_enrichment; raise exception 'Expected private cache denial';
  exception when insufficient_privilege then null; end;
  begin
    update public.inventory_items set tags=array['forged'] where id=item; raise exception 'Expected direct write denial';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
  assert not exists(select 1 from public.inventory_items where household_id=h), 'outsider read metadata';
  reset role;
  set local role anon;
  begin
    perform public.claim_item_enrichment(); raise exception 'Expected anonymous worker denial';
  exception when insufficient_privilege then null; end;
  reset role;
end;
$$;
rollback;
