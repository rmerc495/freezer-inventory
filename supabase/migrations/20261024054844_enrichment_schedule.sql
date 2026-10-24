begin;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create function private.dispatch_item_enrichment() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_token text;
begin
  if not exists (select 1 from private.item_enrichment
    where status in ('pending','processing') and next_attempt_at <= now()) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name='enrichment_worker_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name='enrichment_worker_token';
  -- Deployment can install the schema before its secrets are configured.
  if v_url is null or v_token is null then return; end if;
  perform net.http_post(url:=v_url,
    headers:=jsonb_build_object('Content-Type','application/json','x-worker-secret',v_token),
    body:='{}'::jsonb, timeout_milliseconds:=55000);
end;
$$;
revoke all on function private.dispatch_item_enrichment() from public, anon, authenticated;
select cron.schedule('inventory-enrichment', '* * * * *', 'select private.dispatch_item_enrichment();');
commit;
