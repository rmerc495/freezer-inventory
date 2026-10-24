begin;
insert into auth.users(id,email) values ('11111111-1111-4111-8111-111111111111','tags-owner@example.invalid');
update private.item_enrichment set next_attempt_at=now()+interval '1 day';
do $$
declare h uuid; f uuid; f2 uuid:=gen_random_uuid(); item uuid; token uuid; stock_time timestamptz; history_count bigint;
begin
  assert private.useful_enrichment_tags(array['Frozen',' Food ','vegetables','vegetables','freezer storage'])=array['vegetables'], 'generic tags retained';
  assert private.useful_enrichment_tags(array['frozen yogurt','desserts'])=array['frozen yogurt','desserts'], 'meaningful food type lost';
  assert private.useful_enrichment_tags('{}')='{}'::text[], 'empty tags changed';
  perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
  h:=public.create_household('Tag Test');
  select id into f from public.freezers where household_id=h and is_default;
  perform public.change_inventory(h,gen_random_uuid(),2,'broccoli');
  select id,updated_at into item,stock_time from public.inventory_items where household_id=h;
  select count(*) into history_count from public.inventory_operations where household_id=h;
  select lease_token into token from public.claim_item_enrichment();
  perform public.finish_item_enrichment(h,'broccoli',token,array['frozen','vegetables','freezer'],array['broccoli florets'],'gpt-5-nano');
  assert (select tags=array['vegetables'] and quantity=2 and updated_at=stock_time from public.inventory_items where id=item), 'write filtering changed stock';
  assert (select tags=array['vegetables'] from private.item_enrichment where household_id=h), 'cache not filtered';
  assert (select count(*)=history_count from public.inventory_operations where household_id=h), 'history changed';
  perform public.save_freezer(h,f2,'Other');
  perform public.change_inventory(h,gen_random_uuid(),1,'broccoli',p_freezer_id=>f2);
  assert (select tags=array['vegetables'] from public.inventory_items where household_id=h and freezer_id=f2), 'cache reuse restored generic tags';
end;
$$;
rollback;
