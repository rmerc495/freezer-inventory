# Automatic organization and search (phase three)

New names are saved immediately and queue a small background enrichment job. Every minute, Supabase Cron wakes the `enrich-items` Edge Function. It keeps claiming and processing batches of up to five names until no due jobs remain or its 45-second time budget runs low. There is no five-item limit per run: 15 names can be processed as three consecutive parallel batches. It sends only the normalized item name to OpenAI. No household IDs, user details, quantities, or freezer names are sent. The API key stays in Supabase function secrets and is never included in browser code.

The default is **GPT-5 nano**, with minimal reasoning, `store: false`, strict JSON output, and a hard limit of 512 output tokens. There is no fallback to a larger model and no tools, embeddings, web search, images, or per-search API calls. The initial live check used roughly 160 input tokens and 55–76 output tokens per name. At the published $0.05/$0.40 per million input/output token rates, this is roughly $0.00004 per name (about four cents per 1,000 names at that usage). Usage varies; the output cap includes reasoning tokens. Source: [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-5-nano). The model is marked deprecated by OpenAI; changing it is an explicit code change requiring another small smoke check, rather than an automatic paid upgrade.

The private cache is keyed by household and normalized name, so case/spacing changes, additional stock, zero-stock reuse, and the same food in different freezers reuse successful results. Existing names are queued during migration. Metadata does not change quantities, operation history, or `updated_at`, preserving Undo and Recently Changed ordering. RLS limits metadata reads to household members; clients cannot write tags or call worker RPCs.

Enrichment instructions prefer 1–3 useful food-group, supported-ingredient, or common-use tags and 0–3 true alternate names, without padding or repeating the item name. Short examples guide the nano model, and uncertain synonyms should be omitted. Generic freezer/storage tags such as `frozen`, `freezer`, and `food` are excluded. Both the output parser and database completion function filter these tags, so a model ignoring the instruction cannot persist them. Existing inventory and cache tags are cleaned without another AI call or changes to stock/history/timestamps. Meaningful food types such as `frozen yogurt` remain allowed. Synonyms should describe the same food, avoiding related-but-different products such as broccolini for broccoli.

## Spelling correction

Single-item submission uses `submit_inventory_item`. It first honors a previously restored spelling, then exact saved names (including zero stock and names from other household freezers). For an unfamiliar name it can immediately reuse one unambiguous saved name differing only by a repeated letter or adjacent-letter swap. Multiple candidates leave the spelling unchanged for the AI check. Numeric/punctuated names, changes to word boundaries, and corrections to words shorter than five letters are excluded from automatic matching. This is deliberately narrower than typo-tolerant search.

For unfamiliar names, the existing structured enrichment response includes nullable `corrected_name`; there is no separate spelling API call. The model is instructed to preserve valid words, brands, regional spellings, ingredient choices and singular/plural forms. The database independently limits a correction to one character edit or transposition in a sufficiently long alphabetic word. The corrected name's tags are cached from the same response, avoiding another enrichment request. Successful correction decisions can be reused on later submissions. Existing inventory is not mass-renamed or sent back through AI when this feature is installed.

Pending additions retain per-operation provenance in `inventory_spelling`. A background correction moves only fresh, tracked additions to the canonical item and reassigns their quantity history. If stock/history was changed before the model returned, it conservatively keeps the submitted spelling; manual Edit name remains available. Existing stock and other freezers keep separate quantities. Open inventories receive correction notices through Realtime or focus/reload refreshes.

**Keep my spelling** splits that submitted quantity back into the original name and reassigns its original add history, so quantity Undo still follows the entry. It is idempotent and records a household preference to retain the original spelling on future submissions. It preserves stock already held under the corrected name and later partner additions. If the entry was undone, consumed below its original amount, or manually renamed before restoration, the action safely rejects and directs the user to Edit name. Dismissal persists in the database, and quantity Undo automatically dismisses the corresponding notice. Only the submitting actor can read or restore their spelling notices; household members continue to see the shared corrected inventory.

Live checks confirmed `peperoni → pepperoni` and `chikcen → chicken`, while `Tillamook`, `chicken wings`, and `popsicle` were unchanged. These five checks used about 324 input tokens and 45–53 output tokens each, including tagging and spelling together. The model and 512-token output limit are unchanged. Run `node --experimental-strip-types scripts/check-spelling.mjs` for the small paid spelling smoke check.

Each batch claims up to five jobs atomically with `FOR UPDATE SKIP LOCKED`, keeping at most five OpenAI calls in flight per invocation. It claims another batch immediately after the previous one finishes. Claims have a two-minute lease and a random token. Only the current token can finish a job. OpenAI and database calls respect the invocation deadline; unclaimed jobs stay queued for the next minute. Rate limiting stops further claims for that run. Timeouts, provider failures, refusals, invalid JSON, and incomplete output retry with 1/2/4/8/16-minute backoff. After six total attempts the job becomes `failed`, limiting repeated paid calls. A crashed sixth attempt is also retired when its lease expires. Names still save and remain searchable while enrichment is unavailable.

The existing search box now matches names, tags, and synonyms locally, ignoring case and accents. Every query word must match, with one typo/transposition allowed for words of at least four characters, and two edits for words of at least eight characters. Short words use substring matching. Search stays scoped to the selected freezer and positive stock; it retains the selected Name/Recently Changed ordering. Realtime updates, focus refreshes, and normal inventory reloads pick up generated metadata.

## Setup

Save `OPENAI_ENRICHMENT_KEY` in the ignored `.env.local`. Never use a `VITE_` prefix for it. With an authenticated Supabase CLI and the project linked, run from this repository:

```powershell
npx.cmd --offline supabase db push --linked --dry-run
npx.cmd --offline supabase db push --linked
node scripts/prepare-enrichment-secrets.mjs
npx.cmd --offline supabase secrets set --env-file .local/enrichment-secrets.env
npx.cmd --offline supabase functions deploy enrich-items --use-api
npx.cmd --offline supabase db query --linked --file .local/enrichment-vault.sql
```

Remove `--offline` if Supabase is not already cached. The preparation script keeps a random worker credential in `.local/enrichment-worker-token`, writes ignored secret upload files, and creates SQL that installs the worker URL and credential in Vault. Never commit these files. The function performs its own `x-worker-secret` authentication; its gateway JWT check is disabled intentionally because the caller is Cron. No browser invocation is required. Supabase's [scheduled function guidance](https://supabase.com/docs/guides/functions/schedule-functions) describes Cron, pg_net, and Vault.

The preparation script can be rerun to rotate the OpenAI key. After a successful upload and Vault installation, delete the temporary `.local/enrichment-secrets.env` and `.local/enrichment-vault.sql`; keep the worker token for repeatable setup.

## Verification and operations

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:e2e
npx.cmd --offline supabase db query --linked --file supabase/tests/item_enrichment.sql
# Makes three very small paid calls; prints metadata and token counts, never keys:
node --experimental-strip-types scripts/check-enrichment.mjs
# Check deployed authentication and process any due jobs using the saved worker token:
node scripts/check-enrichment-worker.mjs
# Requires a built dist/ and saved worker token:
node scripts/check-bundle-secrets.mjs
```

Inspect job counts without printing food names or secrets:

```sql
select status, count(*), max(attempts) as max_attempts
from private.item_enrichment group by status;
```

After addressing a billing, permission, or provider issue, an administrator can retry exhausted names deliberately:

```sql
update private.item_enrichment
set status='pending', attempts=0, next_attempt_at=now(), lease_token=null, last_error=null
where status='failed';
```

The rollback-only database test covers immediate save, queue deduplication, server-only claims, leases, stale completion, backoff, retry limits, metadata validation, cache reuse across freezers/restocks, timestamps/history, and household isolation. Unit tests cover the output boundary and typo search; browser tests cover names, tags, synonyms, typos, zero-stock exclusion, and metadata arriving after an immediate save.
