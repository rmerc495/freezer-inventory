create or replace function public.rename_inventory_item(
  p_household_id uuid, p_request_id uuid, p_item_id uuid, p_expected_name text,
  p_name text, p_merge_target_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_source public.inventory_items; v_target public.inventory_items;
  v_previous private.item_name_corrections; v_change record;
  v_name text := private.clean_item_name(p_name);
  v_request jsonb; v_result jsonb; v_history jsonb := '[]'::jsonb;
begin
  if not private.is_household_member(p_household_id) then
    raise exception 'Household access required' using errcode = '42501';
  end if;
  perform 1 from public.households where id=p_household_id for update;
  if p_request_id is null or p_item_id is null or p_expected_name is null or v_name is null
    or char_length(v_name) not between 1 and 200 then
    raise exception 'Enter an item name of 1-200 characters' using errcode = '22023';
  end if;
  v_request := jsonb_build_object('item_id',p_item_id,'expected_name',p_expected_name,
    'name',lower(v_name),'merge_target_id',p_merge_target_id);
  select * into v_previous from private.item_name_corrections where request_id=p_request_id;
  if found then
    if v_previous.household_id<>p_household_id or v_previous.actor_id<>auth.uid() or v_previous.request<>v_request then
      raise exception 'Request ID already used for another correction' using errcode='22023';
    end if;
    return v_previous.result;
  end if;
  select * into v_source from public.inventory_items where household_id=p_household_id and id=p_item_id for update;
  if not found or v_source.name<>p_expected_name then
    raise exception 'This item has changed. Close the editor and reopen it.' using errcode='22023';
  end if;
  select * into v_target from public.inventory_items where household_id=p_household_id
    and freezer_id=v_source.freezer_id and normalized_name=lower(v_name) and id<>v_source.id for update;
  if found then
    if p_merge_target_id is distinct from v_target.id then
      raise exception 'A matching item exists. Review and confirm the merge.' using errcode='22023';
    end if;
    if v_source.quantity::bigint + v_target.quantity > 2147483647 then
      raise exception 'Combined quantity would be too large' using errcode='22023';
    end if;
    -- Preserve an exact audit snapshot before moving history to the survivor.
    select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) into v_history
      from public.inventory_changes c where c.item_id in (v_source.id,v_target.id);
    -- A bulk operation may have changed BOTH spellings. Consolidate its deltas
    -- once, including the zero-net case, without duplicating Undo's item key.
    for v_change in select s.operation_id, s.quantity_before+t.quantity_before as before_total,
      s.quantity_after+t.quantity_after as after_total
      from public.inventory_changes s join public.inventory_changes t
        on t.operation_id=s.operation_id and t.item_id=v_target.id where s.item_id=v_source.id loop
      delete from public.inventory_changes where operation_id=v_change.operation_id and item_id=v_source.id;
      if v_change.before_total=v_change.after_total then
        delete from public.inventory_changes where operation_id=v_change.operation_id and item_id=v_target.id;
      else
        update public.inventory_changes set quantity_before=v_change.before_total, quantity_after=v_change.after_total
          where operation_id=v_change.operation_id and item_id=v_target.id;
      end if;
    end loop;
    update public.inventory_changes set item_id=v_target.id where item_id=v_source.id;
    update public.inventory_items set quantity=quantity+v_source.quantity,updated_at=clock_timestamp() where id=v_target.id;
    delete from public.inventory_items where id=v_source.id;
    v_result := jsonb_build_object('item_id',v_target.id,'name',v_target.name,'merged',true);
  else
    if p_merge_target_id is not null then
      raise exception 'The matching item changed. Review the name again.' using errcode='22023';
    end if;
    update public.inventory_items set name=initcap(v_name), updated_at=clock_timestamp() where id=v_source.id;
    v_result := jsonb_build_object('item_id',v_source.id,'name',initcap(v_name),'merged',false);
  end if;
  insert into private.item_name_corrections(request_id,household_id,actor_id,request,result,original_history)
    values(p_request_id,p_household_id,auth.uid(),v_request,v_result,v_history);
  return v_result;
end;
$$;
