-- Writes go through authenticated RPCs so quantities and history change together.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create function private.clean_item_name(value text) returns text
language sql immutable strict set search_path = '' as $$
  select btrim(regexp_replace(value, '[[:space:]]+', ' ', 'g'));
$$;

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  owner_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index household_members_user_idx on public.household_members(user_id, household_id);
create index households_owner_idx on public.households(owner_id);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  normalized_name text generated always as (lower(private.clean_item_name(name))) stored,
  quantity integer not null default 0 check (quantity >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, normalized_name),
  unique (household_id, id)
);
create index inventory_items_recent_idx on public.inventory_items(household_id, updated_at desc);

-- An operation can hold multiple changes when bulk entry is added later.
-- Client-generated IDs make retrying a request safe after a network timeout.
create table public.inventory_operations (
  id uuid primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  actor_id uuid not null references auth.users(id),
  kind text not null check (kind in ('change', 'undo')),
  request jsonb not null,
  undo_of uuid unique,
  created_at timestamptz not null default now(),
  unique (household_id, id),
  foreign key (household_id, undo_of) references public.inventory_operations(household_id, id),
  check ((kind = 'undo') = (undo_of is not null))
);
create index inventory_operations_recent_idx on public.inventory_operations(household_id, created_at desc);
create index inventory_operations_actor_idx on public.inventory_operations(actor_id);

create table public.inventory_changes (
  operation_id uuid not null,
  household_id uuid not null,
  item_id uuid not null,
  quantity_before integer not null check (quantity_before >= 0),
  quantity_after integer not null check (quantity_after >= 0),
  delta integer generated always as (quantity_after - quantity_before) stored,
  primary key (operation_id, item_id),
  foreign key (household_id, operation_id) references public.inventory_operations(household_id, id) on delete cascade,
  foreign key (household_id, item_id) references public.inventory_items(household_id, id),
  check (quantity_before <> quantity_after)
);
create index inventory_changes_item_idx on public.inventory_changes(household_id, item_id);

create function private.is_household_member(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.household_members
    where household_id = target and user_id = (select auth.uid()));
$$;

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.inventory_items enable row level security;
alter table public.inventory_operations enable row level security;
alter table public.inventory_changes enable row level security;

create policy household_read on public.households for select to authenticated
  using (private.is_household_member(id));
create policy member_read on public.household_members for select to authenticated
  using (private.is_household_member(household_id));
create policy item_read on public.inventory_items for select to authenticated
  using (private.is_household_member(household_id));
create policy operation_read on public.inventory_operations for select to authenticated
  using (private.is_household_member(household_id));
create policy change_read on public.inventory_changes for select to authenticated
  using (private.is_household_member(household_id));

revoke all on public.households, public.household_members, public.inventory_items,
  public.inventory_operations, public.inventory_changes from anon, authenticated;
grant select on public.households, public.household_members, public.inventory_items,
  public.inventory_operations, public.inventory_changes to authenticated;

create function public.create_household(p_name text default 'Our Freezer') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  insert into public.households(name, owner_id) values (btrim(p_name), auth.uid()) returning id into v_id;
  insert into public.household_members(household_id, user_id) values (v_id, auth.uid());
  return v_id;
end;
$$;

-- Both people sign up first; only the household owner can add the other account.
create function public.add_household_member(p_household_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.households where id = p_household_id and owner_id = auth.uid() for update;
  if not found then raise exception 'Household owner required' using errcode = '42501'; end if;
  insert into public.household_members(household_id, user_id) values (p_household_id, p_user_id)
    on conflict do nothing;
end;
$$;

-- Pass a name to add/restock, or an item ID for the plus/minus buttons.
create function public.change_inventory(
  p_household_id uuid, p_operation_id uuid, p_delta integer,
  p_name text default null, p_item_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.inventory_items;
  v_existing public.inventory_operations;
  v_request jsonb;
  v_name text;
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
    insert into public.inventory_items(household_id, name)
      values (p_household_id, initcap(v_name))
      on conflict (household_id, normalized_name) do nothing;
    select * into strict v_item from public.inventory_items
      where household_id = p_household_id and normalized_name = lower(v_name) for update;
  else
    select * into v_item from public.inventory_items
      where household_id = p_household_id and id = p_item_id for update;
    if not found then raise exception 'Item not found in household' using errcode = '22023'; end if;
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

create function public.undo_inventory(p_household_id uuid, p_operation_id uuid, p_undo_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_original public.inventory_operations;
  v_existing public.inventory_operations;
  v_change record;
  v_quantity integer;
begin
  if not private.is_household_member(p_household_id) then
    raise exception 'Household access required' using errcode = '42501';
  end if;
  perform 1 from public.households where id = p_household_id for update;
  if p_undo_id is null then raise exception 'Undo request ID required' using errcode = '22023'; end if;
  select * into v_existing from public.inventory_operations where id = p_undo_id;
  if found then
    if v_existing.household_id = p_household_id and v_existing.actor_id = auth.uid()
      and v_existing.kind = 'undo' and v_existing.undo_of = p_operation_id then return p_undo_id; end if;
    raise exception 'Undo request ID already used' using errcode = '22023';
  end if;
  select * into v_original from public.inventory_operations
    where id = p_operation_id and household_id = p_household_id;
  if not found or v_original.kind <> 'change' or v_original.actor_id <> auth.uid() then
    raise exception 'Only your own inventory changes can be undone' using errcode = '42501';
  end if;
  if exists (select 1 from public.inventory_operations where undo_of = p_operation_id) then
    raise exception 'Change already undone' using errcode = '22023';
  end if;
  insert into public.inventory_operations(id, household_id, actor_id, kind, request, undo_of)
    values (p_undo_id, p_household_id, auth.uid(), 'undo', jsonb_build_object('undo_of', p_operation_id), p_operation_id);
  for v_change in select * from public.inventory_changes where operation_id = p_operation_id order by item_id loop
    select quantity into strict v_quantity from public.inventory_items where id = v_change.item_id for update;
    -- Compensate only this change; preserve subsequent changes made by either phone.
    if v_quantity::bigint - v_change.delta not between 0 and 2147483647 then
      raise exception 'Cannot undo because the available quantity has changed' using errcode = '22023';
    end if;
    update public.inventory_items set quantity = quantity - v_change.delta, updated_at = clock_timestamp()
      where id = v_change.item_id;
    insert into public.inventory_changes(operation_id, household_id, item_id, quantity_before, quantity_after)
      values (p_undo_id, p_household_id, v_change.item_id, v_quantity, v_quantity - v_change.delta);
  end loop;
  return p_undo_id;
end;
$$;

revoke all on function private.clean_item_name(text), private.is_household_member(uuid) from public, anon, authenticated;
grant execute on function private.is_household_member(uuid) to authenticated;
revoke all on function public.create_household(text), public.add_household_member(uuid, uuid),
  public.change_inventory(uuid, uuid, integer, text, uuid), public.undo_inventory(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.create_household(text), public.add_household_member(uuid, uuid),
  public.change_inventory(uuid, uuid, integer, text, uuid), public.undo_inventory(uuid, uuid, uuid)
  to authenticated;

-- Realtime reads use the same membership policies as ordinary inventory reads.
alter publication supabase_realtime add table public.inventory_items;

commit;
