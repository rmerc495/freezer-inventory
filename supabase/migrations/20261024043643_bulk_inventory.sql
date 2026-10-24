begin;

-- One household lock, one operation, and one change per distinct food name.
-- Existing undo_inventory already reverses every change in an operation atomically.
create function public.bulk_add_inventory(
  p_household_id uuid, p_operation_id uuid, p_freezer_id uuid, p_items jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb;
  v_batch jsonb;
  v_request jsonb;
  v_existing public.inventory_operations;
  v_item public.inventory_items;
  v_name text;
  v_quantity bigint;
  v_time timestamptz;
begin
  if not private.is_household_member(p_household_id) then
    raise exception 'Household access required' using errcode = '42501';
  end if;
  perform 1 from public.households where id = p_household_id for update;
  if p_operation_id is null or p_freezer_id is null then
    raise exception 'Request ID and freezer required' using errcode = '22023';
  end if;
  perform 1 from public.freezers where id = p_freezer_id and household_id = p_household_id;
  if not found then raise exception 'Freezer not found in household' using errcode = '22023'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Provide a list of items' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'Enter between 1 and 100 item lines' using errcode = '22023';
  end if;
  for v_row in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_row) <> 'object' or jsonb_typeof(v_row->'name') is distinct from 'string'
      or jsonb_typeof(v_row->'quantity') is distinct from 'number' then
      raise exception 'Each item needs a name and a whole quantity' using errcode = '22023';
    end if;
    v_name := private.clean_item_name(v_row->>'name');
    if char_length(v_name) not between 1 and 200 or (v_row->>'quantity') !~ '^[0-9]{1,10}$' then
      raise exception 'Use item names of 1-200 characters and positive whole quantities' using errcode = '22023';
    end if;
    v_quantity := (v_row->>'quantity')::bigint;
    if v_quantity not between 1 and 2147483647 then
      raise exception 'Quantity must be between 1 and 2147483647' using errcode = '22023';
    end if;
  end loop;
  -- A canonical fingerprint permits retries with equivalent case/whitespace/order.
  select jsonb_agg(jsonb_build_object('name', name, 'quantity', quantity) order by name)
    into v_batch from (
      select lower(private.clean_item_name(value->>'name')) as name,
        sum((value->>'quantity')::bigint) as quantity
      from jsonb_array_elements(p_items) group by 1
    ) combined;
  v_request := jsonb_build_object('bulk_items', v_batch, 'freezer_id', p_freezer_id);
  select * into v_existing from public.inventory_operations where id = p_operation_id;
  if found then
    if v_existing.household_id <> p_household_id or v_existing.actor_id <> auth.uid()
      or v_existing.kind <> 'change' or v_existing.request <> v_request then
      raise exception 'Operation ID already used for a different request' using errcode = '22023';
    end if;
    return p_operation_id;
  end if;
  v_time := clock_timestamp();
  insert into public.inventory_operations(id, household_id, actor_id, kind, request)
    values (p_operation_id, p_household_id, auth.uid(), 'change', v_request);
  for v_row in select value from jsonb_array_elements(v_batch) loop
    v_name := v_row->>'name'; v_quantity := (v_row->>'quantity')::bigint;
    if v_quantity > 2147483647 then
      raise exception 'Combined quantity is too large for %', initcap(v_name) using errcode = '22023';
    end if;
    insert into public.inventory_items(household_id, freezer_id, name)
      values (p_household_id, p_freezer_id, initcap(v_name))
      on conflict (household_id, freezer_id, normalized_name) do nothing;
    select * into strict v_item from public.inventory_items
      where household_id = p_household_id and freezer_id = p_freezer_id and normalized_name = v_name for update;
    if v_item.quantity::bigint + v_quantity > 2147483647 then
      raise exception 'Quantity would be too large for %', v_item.name using errcode = '22023';
    end if;
    insert into public.inventory_changes(operation_id, household_id, item_id, quantity_before, quantity_after)
      values (p_operation_id, p_household_id, v_item.id, v_item.quantity, (v_item.quantity + v_quantity)::integer);
    update public.inventory_items set quantity = (quantity + v_quantity)::integer, updated_at = v_time where id = v_item.id;
  end loop;
  return p_operation_id;
end;
$$;
revoke all on function public.bulk_add_inventory(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.bulk_add_inventory(uuid, uuid, uuid, jsonb) to authenticated;
commit;
