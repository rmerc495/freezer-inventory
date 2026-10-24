begin;

alter table public.inventory_items
  add column tags text[] not null default '{}',
  add column synonyms text[] not null default '{}';

-- Cache and durable queue share a household/name key. Never share names across
-- households. Zero-stock items and moves retain/reuse successful metadata.
create table private.item_enrichment (
  household_id uuid not null references public.households(id) on delete cascade,
  normalized_name text not null,
  status text not null default 'pending' check (status in ('pending','processing','ready','failed')),
  tags text[] not null default '{}',
  synonyms text[] not null default '{}',
  attempts integer not null default 0 check (attempts between 0 and 6),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  last_error text,
  model text,
  completed_at timestamptz,
  primary key (household_id, normalized_name)
);
alter table private.item_enrichment enable row level security;
revoke all on private.item_enrichment from public, anon, authenticated;
create index item_enrichment_due_idx on private.item_enrichment(next_attempt_at)
  where status in ('pending','processing');

create function private.queue_item_enrichment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_name text := lower(private.clean_item_name(new.name)); v_cache private.item_enrichment;
begin
  insert into private.item_enrichment(household_id, normalized_name)
    values (new.household_id, v_name) on conflict do nothing;
  select * into v_cache from private.item_enrichment
    where household_id = new.household_id and normalized_name = v_name;
  new.tags := case when v_cache.status = 'ready' then v_cache.tags else '{}'::text[] end;
  new.synonyms := case when v_cache.status = 'ready' then v_cache.synonyms else '{}'::text[] end;
  return new;
end;
$$;
revoke all on function private.queue_item_enrichment() from public, anon, authenticated;
create trigger inventory_enrichment_queue before insert or update of name
  on public.inventory_items for each row execute function private.queue_item_enrichment();

insert into private.item_enrichment(household_id, normalized_name)
  select distinct household_id, normalized_name from public.inventory_items on conflict do nothing;

-- Only the server worker may claim jobs. SKIP LOCKED and expiring lease tokens
-- prevent overlapping invocations from applying stale or duplicate results.
create function public.claim_item_enrichment()
returns table(household_id uuid, normalized_name text, lease_token uuid)
language plpgsql security definer set search_path = '' as $$
begin
  update private.item_enrichment j set status = 'failed', last_error = 'retry_limit_reached', lease_token = null
    where j.status = 'processing' and j.next_attempt_at <= now() and j.attempts >= 6;
  return query
    with due as (
      select j.household_id, j.normalized_name from private.item_enrichment j
      where j.status in ('pending','processing') and j.next_attempt_at <= now() and j.attempts < 6
      order by j.next_attempt_at, j.household_id, j.normalized_name
      for update skip locked limit 5
    )
    update private.item_enrichment j set status = 'processing', attempts = j.attempts + 1,
      lease_token = gen_random_uuid(), next_attempt_at = now() + interval '2 minutes'
    from due where j.household_id = due.household_id and j.normalized_name = due.normalized_name
    returning j.household_id, j.normalized_name, j.lease_token;
end;
$$;
revoke all on function public.claim_item_enrichment() from public, anon, authenticated;
grant execute on function public.claim_item_enrichment() to service_role;

create function public.finish_item_enrichment(
  p_household_id uuid, p_name text, p_lease_token uuid,
  p_tags text[] default '{}', p_synonyms text[] default '{}', p_model text default null, p_error text default null
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_job private.item_enrichment;
begin
  select * into v_job from private.item_enrichment
    where household_id = p_household_id and normalized_name = p_name
      and status = 'processing' and lease_token = p_lease_token for update;
  if not found then return false; end if;
  if p_error is not null then
    update private.item_enrichment set
      status = case when attempts >= 6 then 'failed' else 'pending' end,
      next_attempt_at = now() + make_interval(secs => (60 * power(2, attempts - 1))::integer),
      last_error = case when p_error ~ '^openai_http_[0-9]{3}$' then p_error else 'enrichment_failed' end,
      lease_token = null
    where household_id = p_household_id and normalized_name = p_name;
    return true;
  end if;
  if p_tags is null or p_synonyms is null or cardinality(p_tags) > 6 or cardinality(p_synonyms) > 6
    or exists (select 1 from unnest(p_tags || p_synonyms) word where word is null or char_length(btrim(word)) not between 1 and 40)
    or p_model is null or char_length(p_model) > 100 then
    raise exception 'Invalid enrichment metadata' using errcode = '22023';
  end if;
  update private.item_enrichment set status = 'ready', tags = p_tags, synonyms = p_synonyms,
    model = p_model, completed_at = now(), last_error = null, lease_token = null
    where household_id = p_household_id and normalized_name = p_name;
  -- Do not touch quantity, timestamps, or operation history. Realtime sends
  -- metadata changes to open inventories without affecting Recently Changed.
  update public.inventory_items set tags = p_tags, synonyms = p_synonyms
    where household_id = p_household_id and normalized_name = p_name;
  return true;
end;
$$;
revoke all on function public.finish_item_enrichment(uuid,text,uuid,text[],text[],text,text) from public, anon, authenticated;
grant execute on function public.finish_item_enrichment(uuid,text,uuid,text[],text[],text,text) to service_role;

commit;
