begin;
-- Keep legacy four-argument calls and fingerprints working; new clients always
-- provide a quantity, which becomes part of the idempotency fingerprint.
drop function public.move_inventory(uuid, uuid, uuid, uuid);
create function public.move_inventory(p_household_id uuid, p_operation_id uuid, p_item_id uuid, p_to_freezer_id uuid, p_quantity integer default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_source public.inventory_items; v_target public.inventory_items; v_existing public.inventory_operations;
  v_amount integer;
  v_request jsonb := jsonb_build_object('move_item_id', p_item_id, 'to_freezer_id', p_to_freezer_id);
begin
  if not private.is_household_member(p_household_id) then raise exception 'Household access required' using errcode = '42501'; end if;
  perform 1 from public.households where id = p_household_id for update;
  if p_operation_id is null or p_item_id is null or p_to_freezer_id is null then raise exception 'Item, destination and request ID required' using errcode = '22023'; end if;
  if p_quantity is not null then
    if p_quantity < 1 then raise exception 'Choose a positive whole quantity to swap' using errcode = '22023'; end if;
    v_request := v_request || jsonb_build_object('quantity', p_quantity);
  end if;
  select * into v_existing from public.inventory_operations where id = p_operation_id;
  if found then
    if v_existing.household_id <> p_household_id or v_existing.actor_id <> auth.uid() or v_existing.kind <> 'change' or v_existing.request <> v_request then
      raise exception 'Operation ID already used for a different request' using errcode = '22023';
    end if;
    return p_operation_id;
  end if;
  perform 1 from public.freezers where id = p_to_freezer_id and household_id = p_household_id;
  if not found then raise exception 'Destination freezer not found in household' using errcode = '22023'; end if;
  select * into v_source from public.inventory_items where id = p_item_id and household_id = p_household_id for update;
  if not found or v_source.quantity = 0 then raise exception 'Item is no longer in stock' using errcode = '22023'; end if;
  if v_source.freezer_id = p_to_freezer_id then raise exception 'Choose a different freezer' using errcode = '22023'; end if;
  v_amount := coalesce(p_quantity, v_source.quantity);
  if v_amount > v_source.quantity then raise exception 'Only % available in this freezer. Choose a smaller quantity.', v_source.quantity using errcode = '22023'; end if;
  insert into public.inventory_items(household_id, freezer_id, name) values (p_household_id, p_to_freezer_id, v_source.name)
    on conflict (household_id, freezer_id, normalized_name) do nothing;
  select * into strict v_target from public.inventory_items where household_id = p_household_id
    and freezer_id = p_to_freezer_id and normalized_name = v_source.normalized_name for update;
  if v_target.quantity::bigint + v_amount > 2147483647 then raise exception 'Destination quantity would be too large' using errcode = '22023'; end if;
  insert into public.inventory_operations(id, household_id, actor_id, kind, request)
    values (p_operation_id, p_household_id, auth.uid(), 'change', v_request);
  insert into public.inventory_changes(operation_id, household_id, item_id, quantity_before, quantity_after) values
    (p_operation_id, p_household_id, v_source.id, v_source.quantity, v_source.quantity - v_amount),
    (p_operation_id, p_household_id, v_target.id, v_target.quantity, v_target.quantity + v_amount);
  update public.inventory_items set quantity = quantity - v_amount, updated_at = clock_timestamp() where id = v_source.id;
  update public.inventory_items set quantity = quantity + v_amount, updated_at = clock_timestamp() where id = v_target.id;
  return p_operation_id;
end;
$$;

revoke all on function public.move_inventory(uuid, uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.move_inventory(uuid, uuid, uuid, uuid, integer) to authenticated;
commit;
