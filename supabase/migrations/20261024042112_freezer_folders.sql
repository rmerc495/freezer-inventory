begin;

create table public.freezers (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  normalized_name text generated always as (lower(private.clean_item_name(name))) stored,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (household_id, id),
  unique (household_id, normalized_name)
);
create unique index freezers_default_idx on public.freezers(household_id) where is_default;
alter table public.freezers enable row level security;
create policy freezer_read on public.freezers for select to authenticated
  using (private.is_household_member(household_id));
revoke all on public.freezers from public, anon, authenticated;
grant select on public.freezers to authenticated;

-- Preserve item IDs and change history while giving every existing household a folder.
insert into public.freezers(household_id, name, is_default)
  select id, 'Main Freezer', true from public.households;
alter table public.inventory_items add column freezer_id uuid;
update public.inventory_items i set freezer_id = f.id from public.freezers f
  where f.household_id = i.household_id and f.is_default;
alter table public.inventory_items alter column freezer_id set not null;
alter table public.inventory_items add constraint inventory_items_freezer_fkey
  foreign key (household_id, freezer_id) references public.freezers(household_id, id);
alter table public.inventory_items drop constraint inventory_items_household_id_normalized_name_key;
alter table public.inventory_items add constraint inventory_items_freezer_name_key
  unique (household_id, freezer_id, normalized_name);

create or replace function public.create_household(p_name text default 'Our Freezer') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  insert into public.households(name, owner_id) values (btrim(p_name), auth.uid()) returning id into v_id;
  insert into public.household_members(household_id, user_id) values (v_id, auth.uid());
  insert into public.freezers(household_id, name, is_default) values (v_id, 'Main Freezer', true);
  return v_id;
end;
$$;

-- Caller supplies a freezer UUID so a lost create response can be retried safely.
create function public.save_freezer(p_household_id uuid, p_freezer_id uuid, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_name text := private.clean_item_name(p_name);
begin
  if not private.is_household_member(p_household_id) then raise exception 'Household access required' using errcode = '42501'; end if;
  perform 1 from public.households where id = p_household_id for update;
  if p_freezer_id is null or v_name is null or char_length(v_name) not between 1 and 100 then
    raise exception 'Enter a freezer name of 1-100 characters' using errcode = '22023';
  end if;
  if exists (select 1 from public.freezers where id = p_freezer_id and household_id <> p_household_id) then
    raise exception 'Freezer not found in household' using errcode = '42501';
  end if;
  insert into public.freezers(id, household_id, name) values (p_freezer_id, p_household_id, v_name)
    on conflict (id) do update set name = excluded.name
      where public.freezers.household_id = excluded.household_id;
  if not found then raise exception 'Freezer not found in household' using errcode = '42501'; end if;
  return p_freezer_id;
exception when unique_violation then
  raise exception 'A freezer with that name already exists' using errcode = '22023';
end;
$$;

-- Replace the five-argument endpoint with an optional sixth argument. Existing callers
-- still use the default freezer and retain their original retry fingerprints.
drop function public.change_inventory(uuid, uuid, integer, text, uuid);
create function public.change_inventory(
  p_household_id uuid, p_operation_id uuid, p_delta integer,
  p_name text default null, p_item_id uuid default null, p_freezer_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.inventory_items;
  v_existing public.inventory_operations;
  v_request jsonb;
  v_name text;
  v_freezer_id uuid;
begin
  if not private.is_household_member(p_household_id) then
    raise exception 'Household access required' using errcode = '42501';
  end if;
  -- Serialize household writes, including duplicate adds, retries and Undo.
  perform 1 from public.households where id = p_household_id for update;
  if p_operation_id is null or p_delta is null or p_delta = 0
    or ((p_name is null) = (p_item_id is null)) then
    raise exception 'Provide an operation ID, nonzero quantity change, and either a name or item ID' using errcode = '22023';
  end if;
  v_name := private.clean_item_name(p_name);
  v_request := jsonb_build_object('delta', p_delta, 'name', lower(v_name), 'item_id', p_item_id);
  if p_freezer_id is not null then v_request := v_request || jsonb_build_object('freezer_id', p_freezer_id); end if;
  select * into v_existing from public.inventory_operations where id = p_operation_id;
  if found then
    if v_existing.household_id <> p_household_id or v_existing.actor_id <> auth.uid()
      or v_existing.kind <> 'change' or v_existing.request <> v_request then
      raise exception 'Operation ID already used for a different request' using errcode = '22023';
    end if;
    return p_operation_id;
  end if;
  if p_name is not null then
    if char_length(v_name) not between 1 and 200 or p_delta < 1 then
      raise exception 'Adding an item requires a name of 1-200 characters and positive quantity' using errcode = '22023';
    end if;
    select id into v_freezer_id from public.freezers where household_id = p_household_id
      and (id = p_freezer_id or (p_freezer_id is null and is_default)) ;
    if not found then raise exception 'Freezer not found in household' using errcode = '22023'; end if;
    insert into public.inventory_items(household_id, freezer_id, name)
      values (p_household_id, v_freezer_id, initcap(v_name))
      on conflict (household_id, freezer_id, normalized_name) do nothing;
    select * into strict v_item from public.inventory_items
      where household_id = p_household_id and freezer_id = v_freezer_id and normalized_name = lower(v_name) for update;
  else
    select * into v_item from public.inventory_items
      where household_id = p_household_id and id = p_item_id for update;
    if not found or (p_freezer_id is not null and v_item.freezer_id <> p_freezer_id) then raise exception 'Item not found in freezer' using errcode = '22023'; end if;
  end if;
  if v_item.quantity::bigint + p_delta not between 0 and 2147483647 then
    raise exception 'Quantity would be negative or too large' using errcode = '22023';
  end if;
  insert into public.inventory_operations(id, household_id, actor_id, kind, request)
    values (p_operation_id, p_household_id, auth.uid(), 'change', v_request);
  insert into public.inventory_changes(operation_id, household_id, item_id, quantity_before, quantity_after)
    values (p_operation_id, p_household_id, v_item.id, v_item.quantity, v_item.quantity + p_delta);
  update public.inventory_items set quantity = quantity + p_delta, updated_at = clock_timestamp()
    where id = v_item.id;
  return p_operation_id;
end;
$$;


-- A move is one operation with two quantity changes, so existing Undo reverses both.
create function public.move_inventory(p_household_id uuid, p_operation_id uuid, p_item_id uuid, p_to_freezer_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_source public.inventory_items; v_target public.inventory_items; v_existing public.inventory_operations;
  v_request jsonb := jsonb_build_object('move_item_id', p_item_id, 'to_freezer_id', p_to_freezer_id);
begin
  if not private.is_household_member(p_household_id) then raise exception 'Household access required' using errcode = '42501'; end if;
  perform 1 from public.households where id = p_household_id for update;
  if p_operation_id is null or p_item_id is null or p_to_freezer_id is null then raise exception 'Item, destination and request ID required' using errcode = '22023'; end if;
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
  insert into public.inventory_items(household_id, freezer_id, name) values (p_household_id, p_to_freezer_id, v_source.name)
    on conflict (household_id, freezer_id, normalized_name) do nothing;
  select * into strict v_target from public.inventory_items where household_id = p_household_id
    and freezer_id = p_to_freezer_id and normalized_name = v_source.normalized_name for update;
  if v_target.quantity::bigint + v_source.quantity > 2147483647 then raise exception 'Destination quantity would be too large' using errcode = '22023'; end if;
  insert into public.inventory_operations(id, household_id, actor_id, kind, request)
    values (p_operation_id, p_household_id, auth.uid(), 'change', v_request);
  insert into public.inventory_changes(operation_id, household_id, item_id, quantity_before, quantity_after) values
    (p_operation_id, p_household_id, v_source.id, v_source.quantity, 0),
    (p_operation_id, p_household_id, v_target.id, v_target.quantity, v_target.quantity + v_source.quantity);
  update public.inventory_items set quantity = 0, updated_at = clock_timestamp() where id = v_source.id;
  update public.inventory_items set quantity = quantity + v_source.quantity, updated_at = clock_timestamp() where id = v_target.id;
  return p_operation_id;
end;
$$;

revoke all on function public.save_freezer(uuid, uuid, text), public.move_inventory(uuid, uuid, uuid, uuid),
  public.change_inventory(uuid, uuid, integer, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.save_freezer(uuid, uuid, text), public.move_inventory(uuid, uuid, uuid, uuid),
  public.change_inventory(uuid, uuid, integer, text, uuid, uuid) to authenticated;
alter publication supabase_realtime add table public.freezers;
commit;
