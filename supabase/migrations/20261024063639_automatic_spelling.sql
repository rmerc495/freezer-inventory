begin;
alter table private.item_enrichment add column corrected_name text,
  add column spelling_checked boolean not null default false;

create table private.spelling_preferences (
  household_id uuid not null references public.households(id) on delete cascade,
  normalized_name text not null,
  primary key(household_id,normalized_name)
);
alter table private.spelling_preferences enable row level security;
revoke all on private.spelling_preferences from public,anon,authenticated;

create table public.inventory_spelling (
  operation_id uuid primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  freezer_id uuid not null,
  actor_id uuid not null references auth.users(id),
  original_name text not null,
  corrected_name text,
  quantity integer not null check(quantity>0),
  status text not null check(status in ('pending','unchanged','corrected','restored')),
  dismissed boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key(household_id,operation_id) references public.inventory_operations(household_id,id) on delete cascade,
  foreign key(household_id,freezer_id) references public.freezers(household_id,id)
);
create index inventory_spelling_household_idx on public.inventory_spelling(household_id,freezer_id,created_at desc);
create index inventory_spelling_actor_idx on public.inventory_spelling(actor_id);
alter table public.inventory_spelling enable row level security;
create policy own_spelling_read on public.inventory_spelling for select to authenticated
  using(actor_id=(select auth.uid()) and private.is_household_member(household_id));
revoke all on public.inventory_spelling from public,anon,authenticated;
grant select on public.inventory_spelling to authenticated;
alter publication supabase_realtime add table public.inventory_spelling;

create function private.dismiss_undone_spelling() returns trigger
language plpgsql set search_path='' as $$
begin
  update public.inventory_spelling set dismissed=true where operation_id=new.undo_of;
  return new;
end;
$$;
revoke all on function private.dismiss_undone_spelling() from public,anon,authenticated;
create trigger dismiss_undone_spelling after insert on public.inventory_operations
  for each row when(new.kind='undo') execute function private.dismiss_undone_spelling();

-- Restrict corrections to one edit in an alphabetic name, preserving word
-- boundaries. Unknown brands with digits/punctuation and short names stay exact.
create function private.spelling_difference(a text,b text) returns text
language plpgsql immutable strict set search_path='' as $$
declare i integer:=1; n integer:=char_length(a); m integer:=char_length(b);
  a_words text[]:=string_to_array(a,' '); b_words text[]:=string_to_array(b,' '); word_index integer;
begin
  if a=b or least(n,m)<5 or greatest(n,m)>200 or abs(n-m)>1
    or a!~'^[a-z]+( [a-z]+)*$' or b!~'^[a-z]+( [a-z]+)*$'
    or cardinality(string_to_array(a,' '))<>cardinality(string_to_array(b,' ')) then return null; end if;
  for word_index in 1..cardinality(a_words) loop
    if a_words[word_index]<>b_words[word_index] and least(char_length(a_words[word_index]),char_length(b_words[word_index]))<5 then return null; end if;
  end loop;
  if n>m then return private.spelling_difference(b,a); end if;
  while i<=n and substr(a,i,1)=substr(b,i,1) loop i:=i+1; end loop;
  if n=m then
    if substr(a,i,1)=substr(b,i+1,1) and substr(a,i+1,1)=substr(b,i,1)
      and substr(a,i+2)=substr(b,i+2) then return 'transpose'; end if;
    if substr(a,i+1)=substr(b,i+1) then return 'edit'; end if;
  elsif substr(a,i)=substr(b,i+1) then
    if substr(b,i,1)=substr(b,i-1,1) or substr(b,i,1)=substr(b,i+1,1) then return 'repeat'; end if;
    return 'edit';
  end if;
  return null;
end;
$$;
revoke all on function private.spelling_difference(text,text) from public,anon,authenticated;

create function public.submit_inventory_item(p_household_id uuid,p_operation_id uuid,p_freezer_id uuid,p_name text,p_delta integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_name text:=lower(private.clean_item_name(p_name)); v_chosen text; v_status text;
  v_previous public.inventory_spelling; v_cache private.item_enrichment; v_candidates text[]; v_exact boolean; v_keep boolean;
begin
  if not private.is_household_member(p_household_id) then raise exception 'Household access required' using errcode='42501'; end if;
  perform 1 from public.households where id=p_household_id for update;
  if p_operation_id is null or p_freezer_id is null or v_name is null or char_length(v_name) not between 1 and 200 or p_delta is null or p_delta<1 then
    raise exception 'Provide a name, positive quantity, freezer and request ID' using errcode='22023'; end if;
  select * into v_previous from public.inventory_spelling where operation_id=p_operation_id;
  if found then
    if v_previous.household_id<>p_household_id or v_previous.actor_id<>auth.uid() or v_previous.freezer_id<>p_freezer_id
      or lower(v_previous.original_name)<>v_name or v_previous.quantity<>p_delta then
      raise exception 'Operation ID already used for another submission' using errcode='22023'; end if;
    return p_operation_id;
  end if;
  if exists(select 1 from public.inventory_operations where id=p_operation_id) then
    raise exception 'Operation ID already used' using errcode='22023'; end if;
  v_keep:=exists(select 1 from private.spelling_preferences where household_id=p_household_id and normalized_name=v_name);
  v_exact:=exists(select 1 from public.inventory_items where household_id=p_household_id and normalized_name=v_name);
  v_chosen:=v_name;
  v_status:=case when v_keep or v_exact then 'unchanged' else 'pending' end;
  if not v_keep and exists(select 1 from public.inventory_spelling where household_id=p_household_id and freezer_id=p_freezer_id
    and lower(original_name)=v_name and status='pending') then v_status:='pending'; end if;
  select * into v_cache from private.item_enrichment where household_id=p_household_id and normalized_name=v_name;
  if not v_keep and not v_exact then
    if v_cache.status='ready' and v_cache.spelling_checked then
      if private.spelling_difference(v_name,v_cache.corrected_name) is not null then v_chosen:=v_cache.corrected_name;
      else v_status:='unchanged'; end if;
    else
      select array_agg(normalized_name) into v_candidates from (
        select distinct normalized_name from public.inventory_items where household_id=p_household_id
          and private.spelling_difference(v_name,normalized_name) in ('repeat','transpose')
      ) candidates;
      if cardinality(v_candidates)=1 then v_chosen:=v_candidates[1]; end if;
    end if;
  end if;
  if v_chosen<>v_name then v_status:='corrected'; end if;
  perform public.change_inventory(p_household_id,p_operation_id,p_delta,p_name=>v_chosen,p_freezer_id=>p_freezer_id);
  insert into public.inventory_spelling(operation_id,household_id,freezer_id,actor_id,original_name,corrected_name,quantity,status)
    values(p_operation_id,p_household_id,p_freezer_id,auth.uid(),initcap(v_name),case when v_status='corrected' then initcap(v_chosen) end,p_delta,v_status);
  -- Older caches have tags but no spelling decision. Check them once when a new
  -- unfamiliar name is submitted, without rechecking ordinary stock changes.
  if v_status='pending' then
    update private.item_enrichment set status='pending',attempts=0,next_attempt_at=now(),lease_token=null
      where household_id=p_household_id and normalized_name=v_name and status='ready' and not spelling_checked;
  end if;
  return p_operation_id;
end;
$$;
revoke all on function public.submit_inventory_item(uuid,uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.submit_inventory_item(uuid,uuid,uuid,text,integer) to authenticated;

-- Each corrected addition retains its own quantity/history, allowing restoration
-- to split just that entry from an existing canonical item without losing stock.
create function private.apply_spelling(p_household_id uuid,p_name text,p_corrected text) returns void
language plpgsql set search_path='' as $$
declare v_source public.inventory_items; v_target public.inventory_items; v_entry public.inventory_spelling;
  v_total bigint; v_cache private.item_enrichment;
begin
  if private.spelling_difference(p_name,p_corrected) is null then
    update public.inventory_spelling set status='unchanged' where household_id=p_household_id and lower(original_name)=p_name and status='pending';
    return;
  end if;
  select * into v_cache from private.item_enrichment where household_id=p_household_id and normalized_name=p_name;
  -- Seed corrected-name metadata from this same response. No second AI call.
  insert into private.item_enrichment(household_id,normalized_name,status,tags,synonyms,model,completed_at,spelling_checked)
    values(p_household_id,p_corrected,'ready',v_cache.tags,v_cache.synonyms,v_cache.model,now(),true)
    on conflict(household_id,normalized_name) do update set status='ready',tags=excluded.tags,synonyms=excluded.synonyms,
      model=excluded.model,completed_at=now(),spelling_checked=true,corrected_name=null,lease_token=null
      where private.item_enrichment.status<>'ready';
  update public.inventory_items i set tags=c.tags,synonyms=c.synonyms from private.item_enrichment c
    where i.household_id=p_household_id and i.normalized_name=p_corrected and c.household_id=i.household_id and c.normalized_name=i.normalized_name;
  for v_source in select * from public.inventory_items where household_id=p_household_id and normalized_name=p_name for update loop
    select sum(s.quantity) into v_total from public.inventory_spelling s join public.inventory_changes c on c.operation_id=s.operation_id
      where s.household_id=p_household_id and s.freezer_id=v_source.freezer_id and lower(s.original_name)=p_name
        and s.status='pending' and c.item_id=v_source.id;
    -- If stock/history was edited before AI returned, keep the original name.
    if v_total is null or v_total<>v_source.quantity or exists(
      select 1 from public.inventory_changes c where c.item_id=v_source.id and not exists(
        select 1 from public.inventory_spelling s where s.operation_id=c.operation_id and s.status='pending'
          and s.household_id=p_household_id and lower(s.original_name)=p_name))
      or exists(select 1 from private.spelling_preferences where household_id=p_household_id and normalized_name=p_name) then
      update public.inventory_spelling set status='unchanged' where household_id=p_household_id and freezer_id=v_source.freezer_id and lower(original_name)=p_name and status='pending';
      continue;
    end if;
    select * into v_target from public.inventory_items where household_id=p_household_id and freezer_id=v_source.freezer_id and normalized_name=p_corrected for update;
    if found and v_target.quantity::bigint+v_total>2147483647 then
      update public.inventory_spelling set status='unchanged' where household_id=p_household_id and freezer_id=v_source.freezer_id and lower(original_name)=p_name and status='pending';
      continue;
    end if;
    if not found then
      insert into public.inventory_items(household_id,freezer_id,name) values(p_household_id,v_source.freezer_id,initcap(p_corrected)) returning * into v_target;
    end if;
    for v_entry in select * from public.inventory_spelling where household_id=p_household_id and freezer_id=v_source.freezer_id
      and lower(original_name)=p_name and status='pending' for update loop
      update public.inventory_changes set item_id=v_target.id where operation_id=v_entry.operation_id and item_id=v_source.id;
      update public.inventory_spelling set status='corrected',corrected_name=v_target.name where operation_id=v_entry.operation_id;
    end loop;
    update public.inventory_items set quantity=quantity+v_source.quantity,updated_at=clock_timestamp() where id=v_target.id;
    delete from public.inventory_items where id=v_source.id;
  end loop;
end;
$$;
revoke all on function private.apply_spelling(uuid,text,text) from public,anon,authenticated;

create function public.finish_item_enrichment_with_spelling(
  p_household_id uuid,p_name text,p_lease_token uuid,p_tags text[] default '{}',p_synonyms text[] default '{}',
  p_model text default null,p_error text default null,p_corrected_name text default null
) returns boolean language plpgsql security definer set search_path='' as $$
declare v_applied boolean; v_corrected text:=lower(private.clean_item_name(p_corrected_name));
begin
  -- Match inventory write lock order before taking cache/job locks.
  perform 1 from public.households where id=p_household_id for update;
  v_applied:=public.finish_item_enrichment(p_household_id,p_name,p_lease_token,p_tags,p_synonyms,p_model,p_error);
  if not v_applied or p_error is not null then return v_applied; end if;
  if private.spelling_difference(p_name,v_corrected) is null then v_corrected:=null; end if;
  update private.item_enrichment set spelling_checked=true,corrected_name=v_corrected where household_id=p_household_id and normalized_name=p_name;
  perform private.apply_spelling(p_household_id,p_name,v_corrected);
  return true;
end;
$$;
revoke all on function public.finish_item_enrichment_with_spelling(uuid,text,uuid,text[],text[],text,text,text) from public,anon,authenticated;
grant execute on function public.finish_item_enrichment_with_spelling(uuid,text,uuid,text[],text[],text,text,text) to service_role;

create function public.restore_inventory_spelling(p_household_id uuid,p_operation_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_entry public.inventory_spelling; v_current public.inventory_items; v_original public.inventory_items;
begin
  if not private.is_household_member(p_household_id) then raise exception 'Household access required' using errcode='42501'; end if;
  perform 1 from public.households where id=p_household_id for update;
  select * into v_entry from public.inventory_spelling where household_id=p_household_id and operation_id=p_operation_id and actor_id=auth.uid() for update;
  if not found then raise exception 'Only your own spelling corrections can be restored' using errcode='42501'; end if;
  if v_entry.status='restored' then return p_operation_id; end if;
  if v_entry.status<>'corrected' or exists(select 1 from public.inventory_operations where undo_of=p_operation_id) then
    raise exception 'This entry is no longer available to restore' using errcode='22023'; end if;
  select i.* into v_current from public.inventory_items i join public.inventory_changes c on c.item_id=i.id
    where c.operation_id=p_operation_id and c.household_id=p_household_id for update of i;
  if not found or v_current.name<>v_entry.corrected_name or v_current.quantity<v_entry.quantity then
    raise exception 'Stock or name has changed. Use Edit name to make this correction.' using errcode='22023'; end if;
  insert into private.spelling_preferences(household_id,normalized_name) values(p_household_id,lower(v_entry.original_name)) on conflict do nothing;
  insert into public.inventory_items(household_id,freezer_id,name) values(p_household_id,v_entry.freezer_id,v_entry.original_name)
    on conflict(household_id,freezer_id,normalized_name) do nothing;
  select * into strict v_original from public.inventory_items where household_id=p_household_id and freezer_id=v_entry.freezer_id and normalized_name=lower(v_entry.original_name) for update;
  if v_original.quantity::bigint+v_entry.quantity>2147483647 then raise exception 'Restored quantity would be too large' using errcode='22023'; end if;
  update public.inventory_items set quantity=quantity-v_entry.quantity,updated_at=clock_timestamp() where id=v_current.id;
  update public.inventory_items set quantity=quantity+v_entry.quantity,updated_at=clock_timestamp() where id=v_original.id;
  update public.inventory_changes set item_id=v_original.id where operation_id=p_operation_id and item_id=v_current.id;
  update public.inventory_spelling set status='restored' where operation_id=p_operation_id;
  return p_operation_id;
end;
$$;
revoke all on function public.restore_inventory_spelling(uuid,uuid) from public,anon,authenticated;
grant execute on function public.restore_inventory_spelling(uuid,uuid) to authenticated;

create function public.dismiss_inventory_spelling(p_household_id uuid,p_operation_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
begin
  if not private.is_household_member(p_household_id) then raise exception 'Household access required' using errcode='42501'; end if;
  update public.inventory_spelling set dismissed=true where household_id=p_household_id and operation_id=p_operation_id and actor_id=auth.uid();
  if not found then raise exception 'Only your own spelling notices can be dismissed' using errcode='42501'; end if;
  return p_operation_id;
end;
$$;
revoke all on function public.dismiss_inventory_spelling(uuid,uuid) from public,anon,authenticated;
grant execute on function public.dismiss_inventory_spelling(uuid,uuid) to authenticated;
commit;
