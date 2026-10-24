-- Remove the unused record while retaining row locking and lease validation.
create or replace function public.finish_item_enrichment(
  p_household_id uuid, p_name text, p_lease_token uuid,
  p_tags text[] default '{}', p_synonyms text[] default '{}', p_model text default null, p_error text default null
) returns boolean
language plpgsql security definer set search_path = '' as $$

begin
  perform 1 from private.item_enrichment
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
