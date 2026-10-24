# Database architecture

Project: `olgldvjabjhxkbnfpcwh` (Freezer Inventory). PostgreSQL 17 on Supabase.

## Tables

| Table | Purpose |
| --- | --- |
| `households` | Shared inventory boundary and owner account. |
| `household_members` | Supabase Auth user IDs allowed to access a household. |
| `freezers` | Named folders within a household, including one default Main Freezer. |
| `inventory_items` | Title-case display name, normalized duplicate key, whole-package quantity, creation and last-change timestamps. |
| `inventory_operations` | Actor, client-generated request ID, operation kind, request fingerprint, and reference to the operation being undone. |
| `inventory_changes` | Item-level before/after quantities for each operation. Supports multiple items per operation for bulk entry and freezer moves. |

All inventory references include the household ID, preventing a change from referencing another household's item or operation. Zero quantities remain stored for previously used suggestions. The main inventory query must filter `quantity > 0`; suggestions can include zero quantities. Food dates, tags, and AI integrations remain out of scope for the current implementation. Bulk entry is supported by the Phase 2 RPC described below.

## Access and onboarding

Users sign in with Supabase Auth. The first user calls `create_household`; it creates the household and their membership atomically. The interface now supports onboarding using owner-issued, one-time invitation links; see [authentication setup](authentication.md). The original `add_household_member` RPC remains available to the owner for account-UUID administration. No personal accounts or live household were created by these migrations.

Anonymous callers have no table or RPC access. Authenticated members can read only their households and related rows under row-level security. They cannot directly insert, update, or delete table rows. Writes use narrowly granted database functions that independently verify the caller's membership. The household owner alone can add members. User IDs come from the signed-in session, never from a caller-provided actor field.

Private helper functions are in a schema outside the configured Data API schemas. Security-definer functions have an empty search path and schema-qualified table references. These patterns follow the [Supabase function guidance](https://supabase.com/docs/guides/database/functions) and [row-level security guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Frontend RPC contract

Use a publishable Supabase key and the user's authenticated session. Never ship a database password or service-role key to the browser.

| RPC | Parameters | Result |
| --- | --- | --- |
| `create_household` | `p_name` (optional; defaults to Our Freezer) | Household UUID |
| `add_household_member` | `p_household_id`, `p_user_id` | No return value |
| `change_inventory` | `p_household_id`, `p_operation_id`, `p_delta`, either `p_name` or `p_item_id`, optional `p_freezer_id` | Operation UUID |
| `bulk_add_inventory` | `p_household_id`, `p_operation_id`, `p_freezer_id`, `p_items` (JSON array of `{ name, quantity }`) | Operation UUID |
| `save_freezer` | `p_household_id`, `p_freezer_id` (client UUID for create/retry or existing ID for rename), `p_name` | Freezer UUID |
| `move_inventory` | `p_household_id`, `p_operation_id`, `p_item_id`, `p_to_freezer_id`, optional `p_quantity` | Operation UUID |
| `undo_inventory` | `p_household_id`, `p_operation_id` (original change), `p_undo_id` (new request ID) | Undo operation UUID |

For an addition, supply `p_name` and a positive integer delta, defaulting to one in the UI. The database trims and collapses whitespace, title-cases the display name, and combines items using a lowercase normalized name unique within the selected freezer. The same normalized food name in two freezers has separate quantities. It does not merge synonyms, different punctuation, or different product descriptions. This deliberately keeps Chicken Thighs and Boneless Chicken Thighs separate.

For plus/minus, supply `p_item_id` and a delta of `1` or `-1`. Quantities cannot go below zero or exceed PostgreSQL's integer limit. A rejected operation changes neither inventory nor history.

Generate a request UUID once per intentional action and reuse it for retries. Repeating an identical request returns the existing operation without applying it twice. Reusing its ID with different input is rejected. Keep the returned operation ID for the Undo action.

## Undo and concurrency

All inventory RPCs lock the household row before applying changes. This serializes writes from both phones, including simultaneous duplicate adds, so counts are not overwritten. Each successful operation and its history are saved in one transaction.

Undo is a new, recorded compensating operation. It reverses only the original quantity delta, preserving later updates. Only the original actor can undo their operation, and only once; retrying the same Undo request is safe. Undo of an Undo is not supported. If reversing an earlier addition would make current stock negative, Undo is rejected atomically. The frontend should show that error instead of reporting success. The schema imposes no expiration time; the UI can show a short-lived Undo message.

Inventory items are included in Supabase Realtime. An authenticated subscription uses the same membership read policies. The frontend must fetch fresh data on reconnect and after mutation; zero-quantity updates should remove a row from the active list without deleting its database record.

## Item entry and quantity interface

Single-item entry adds one named item at a time with a positive whole quantity defaulting to one. Phase 2 also supports bulk entry as described below. It uses `change_inventory` with a name for additions and an item ID for plus/minus; normalization and duplicate combining stay in the database. Each row has minus, quantity, and plus controls. The active query filters `quantity > 0` and never deletes records.

The latest successful change shows a dismissible Undo message until another successful change replaces it, Undo succeeds, or the freezer or household is left. Undo calls `undo_inventory` with that returned operation ID. A failed Undo retains the message and displays the database error. Failed or uncertain writes offer Retry save using the same UUID and arguments; Dismiss abandons that retry. If a save response was lost, check refreshed stock before submitting a new addition. Request UUIDs use `crypto.getRandomValues` so LAN HTTP previews work as well as HTTPS.

Controls prevent overlapping writes in this browser. Reads refresh after every write attempt, Realtime event/subscription, focus, tab return, and network reconnection. Refresh failures retain the last list, display an error, and offer a read-only retry. A confirmed write remains successful even if its refresh fails. Requests time out after 15 seconds; failed reads surface immediately rather than silently retrying server errors.

`tests/inventory.spec.ts` covers duplicate entry, plus/minus, zero retention, Undo of adds/removals, lost save/Undo responses and request-ID reuse, rejected Undo, independent refresh errors, two mocked account sessions sharing stock, remote Realtime changes to zero, quantity validation, and mobile overflow. The hosted transactional database test passed again with real authenticated roles for both fixture accounts and rolled back all fixtures. These checks do not replace a two-phone test using the user's real accounts. Desktop/mobile inventory screenshots are generated in ignored `.local/` and visually reviewed.

## Multiple freezer folders

Every household has a default **Main Freezer**. Migration `20261024042112_freezer_folders.sql` assigns all existing item records to it without changing their IDs, quantities, timestamps, or history. New households receive it atomically during creation. Existing five-argument `change_inventory` requests continue to use the default freezer for name-based additions and preserve their original retry fingerprints. New UI requests always specify the selected freezer.

Members can create or rename freezers through `save_freezer`; names collapse whitespace and are unique ignoring case within a household. Both members can read the same folders through RLS, but direct writes and anonymous access are denied. A composite foreign key ensures an item's freezer belongs to its household. The duplicate key is now `(household_id, freezer_id, normalized_name)`, which also indexes the freezer relationship. Freezers are included in Realtime; folder reads refresh on changes, reconnection, focus, and returning to a tab.

The **Freezer swap** action opens a modal dialog to choose a destination and positive whole quantity (default one). It transfers that quantity within the same household. Matching destination stock combines; the source retains the rest and is hidden only when it reaches zero. The household lock serializes this with adds, decrements, and Undo. A move writes two quantity changes under one operation ID and uses the existing Undo endpoint to reverse both atomically, preserving later changes. If destination stock has since been used and cannot cover the reversal, the entire Undo is rejected. Freezer deletion is not included. Migration `20261024045319_partial_freezer_swap.sql` adds optional `p_quantity` to `move_inventory`. The UI always sends an explicit quantity; legacy callers omitting it retain the all-stock behavior and original retry fingerprints. Supplied quantities are part of the retry fingerprint, and available stock is checked against the locked source row at save time. Retrying a committed request still succeeds if the source has since reached zero.

All three hosted transactional suites (inventory foundation, household invites, freezer folders) passed after deployment and rolled back their fixtures. The freezer suite covers default creation, duplicate names per freezer, create retries, member renames, move combining/retries, successful and failed atomic Undo, legacy callers, wrong-freezer IDs, cross-household attempts, direct-write denial, outsider reads, and anonymous rejection. A before/after fingerprint confirmed that migration preserved the existing inventory IDs and quantities.

## Phase 2: faster entry and browsing

**Previously used suggestions:** Typing into Item name opens a dropdown directly beneath the field with up to six matching names from the selected freezer. It stays hidden for an empty input. Matches containing the typed text are read in recent-change order and displayed with prefix matches first, then alphabetically. This separate read includes zero-stock records; the active inventory query still requires `quantity > 0`. Household/freezer filters and RLS apply to both queries. LIKE wildcards in typed names are escaped. Clicking or tapping a dropdown option fills the name without saving; Arrow Up/Down and Enter also select, while Escape, Tab, and leaving the field dismiss the dropdown. The field uses the ARIA combobox/listbox pattern. After selection, the user can change quantity before Add item. Suggestions failing to load do not block entry. They refresh after inventory reads and writes, including Realtime/focus refreshes.

**Bulk preview (previous interface):** The bulk-entry interface and Single item/Multiple items tabs were removed at the user’s request. The tested bulk RPC, parser, and history remain available internally; active entry uses autocomplete only. The previous Multiple items interface accepted one food per line, optionally ending in `x 3`, `X 3`, or `× 3`. Plain names default to one; blank lines are ignored, and product numbers elsewhere in names remain literal. The editable preview lets users change names/quantities and remove lines. Invalid quantities, empty/overlong names, combined overflow, and batches over 100 nonblank lines block Save batch. Users can return to the original text; preview edits are separate from that text. The summary counts distinct names and total added packages. The entire batch targets the selected freezer.

**Atomic save:** `bulk_add_inventory` validates the JSON array server-side, checks membership and freezer ownership, locks the household, combines names with the existing database normalization, and writes one operation with one change per distinct item. New display names are title-cased. Any invalid item or quantity overflow rolls back every change and all history. The canonical retry fingerprint includes sorted normalized names, summed quantities, and the freezer ID. Equivalent case/whitespace/order retries return the existing operation; changed content or actor rejects reused IDs. The client retains the same request UUID and arguments after uncertain responses, locks editing while a retry is pending, and preserves the preview after errors.

**Batch Undo:** Existing `undo_inventory` reverses all recorded item deltas under one household lock. Later partner changes remain intact. If any reversal would make a quantity invalid, the whole Undo rolls back. The UI clears a preview only after confirmed success and shows one Undo message for the whole batch. Existing zero-stock records remain reusable in suggestions.

**Sorting:** Name sorts alphabetically. Recently Changed sorts by `updated_at` descending with name and ID tie-breakers. The choice is stored in browser localStorage and applies across freezer navigation/reloads. Single-item writes, moves, Undo, and Realtime reads update the order from database timestamps. All rows written by one bulk save receive the same timestamp and sort alphabetically within that batch. These timestamps describe inventory changes, not food dates.

**Verification:** Parser unit tests cover separators, blank lines/CRLF, product numbers, duplicate combining, invalid/overflow quantities, empty names, and batch limits. Browser tests cover suggestions from zero stock, preview edits/removals, duplicate batches, whole-batch Undo, frozen preview and request reuse after lost responses, sorting after quantity changes/Undo/reload, and mobile overflow. Mobile and desktop preview screenshots are in ignored `.local/` and were visually reviewed. Hosted `supabase/tests/bulk_inventory.sql` checks duplicate merging, canonical retries, multi-item history, shared-account updates, actor-only Undo, zero retention, full rollback on invalid batches or impossible Undo, freezer separation, batch limits, overflow, outsider/cross-household/anonymous denial. All fixtures roll back. Migration `20261024043643_bulk_inventory.sql` adds the RPC without modifying existing inventory records.

## Phase 3: automatic organization and search

`inventory_items.tags` and `synonyms` are member-readable search metadata. A private household/name cache doubles as a durable queue, populated by the item-name trigger and backfilled for existing names. A scheduled server worker uses GPT-5 nano with minimal reasoning and a 512-token output limit. Successful metadata is reused across freezers and restocking without touching stock timestamps or Undo history. Clients cannot call worker RPCs or edit metadata. Retry backoff stops after six attempts. See [enrichment architecture, costs, setup, and recovery](enrichment.md).

Phase three verification passed the production build, 19 unit tests, 31 browser tests, hosted rollback-only database tests, database lint, and a live scheduled enrichment run. All five existing distinct names completed on their first attempt. The deployed worker rejects requests without its private credential. A production bundle scan found neither the OpenAI key nor the worker credential. Security advisors reported no error-level findings; the existing authenticated inventory RPC and Auth password-protection warnings remain unchanged.

## Correcting names and merging duplicates

`rename_inventory_item` accepts a household, retry request UUID, source item ID, expected current name, corrected name, and optional confirmed merge target ID. It checks membership, locks the household, validates the source name, and resolves the normalized name within the source freezer. An existing target requires its exact ID as confirmation; a stale or newly appeared match rejects the request for review. Names use the existing whitespace normalization/title casing. Empty or overlong names and quantity overflow reject atomically.

A plain rename preserves the item ID and quantity. Its name trigger clears old search metadata and reuses or queues enrichment for the corrected name. A merge adds the source quantity to the target, retains the target's metadata, and deletes the redundant source item so its old spelling cannot appear in autocomplete. Items in other freezers remain separate. Zero-stock records support both operations.

Historical changes are reassigned to the surviving item. When one bulk operation touched both spellings, their before/after amounts are combined into one change, preserving the summed delta. Zero-net changes are omitted. History amounts/deltas use bigint to support combined historical totals while current stock remains limited to signed integer quantities. Existing Undo continues to compensate its original delta and preserves later partner changes. Merged source history and colliding target history are snapshotted in the private correction audit, along with the request, actor, and result. Corrections/merges themselves do not create a quantity Undo operation.

The private `item_name_corrections` table is inaccessible to clients and makes retries safe even after the source record has been deleted. Reused IDs with another actor or payload reject. The public RPC follows the existing authenticated SECURITY DEFINER boundary, with a fixed empty search path and explicit membership checks. Security advisors report its expected authenticated-callable warning; no error-level findings were introduced.

The editor opens from **Edit name** on an in-stock row or **Edit saved name** beside the entry label after selecting a saved autocomplete name (including zero stock). The modal previews merges, blocks saving while checking matches, retains and freezes uncertain requests for safe retry, and contains errors beside the correction. It supports Cancel/Escape, focus restoration, and mobile layouts. Similar-name checks before adding and a separate remove-from-suggestions control are not included.

Verification: production build, 19 unit tests, 34 browser tests, all seven rollback-only database suites, and database lint passed. The new database suite covers explicit confirmation, duplicate merging, bulk-history consolidation, quantity Undo after partner changes, zero-stock rename, freezer isolation, retries/actor checks, stale names, overflow rollback, and access denial. Browser checks cover rename, merge, zero-stock correction, mobile layout, cancellation, and uncertain-response retries. The mobile merge screenshot was visually reviewed.

## Automatic spelling on submission

`submit_inventory_item` wraps the existing atomic quantity write with a raw-name retry fingerprint, saved-name matching and a spelling provenance record. `inventory_spelling` stores each submitted operation's original/corrected name and quantity. Its read policy permits only the submitting actor who is still a household member; direct client writes are revoked. Private `spelling_preferences` records spellings explicitly restored by a household member. The worker-only `finish_item_enrichment_with_spelling` stores metadata and applies conservative spelling corrections while holding the household lock before job/cache locks.

Automatic identity transfers preserve each submitted operation's history, rather than folding an unrelated existing quantity into the correction. `restore_inventory_spelling` can therefore split only that addition from a corrected item, retains later partner stock, and keeps quantity Undo working. Restoration and dismissal are idempotent, actor-only operations. Quantity Undo dismisses its notice through a private trigger. The existing manual rename-or-merge path remains available separately.

See [spelling behavior, safeguards, token usage and verification](enrichment.md#spelling-correction). The automatic spelling SQL suite verifies local correction/retries, background correction and cached tags, restoration and subsequent opt-out, partner stock, Undo, brands/short words/ingredient differences, intervening stock changes, RLS, worker-only execution, direct-write denial and outsider rejection. Unit tests validate the structured response; browser tests cover immediate save, background notices, mobile layout, dismissal and retrying restoration after a lost response.

Automatic spelling deployment verification passed the production build, 25 unit tests, 36 browser tests, all nine rollback-only SQL suites, five small live OpenAI checks, and the deployed worker's authentication check. The mobile correction notice was visually reviewed. The production bundle contains neither server credential. Database security advisors have no error-level findings; the three new authenticated save/restore/dismiss RPCs follow the same intentional SECURITY DEFINER authorization boundary as the existing inventory endpoints.

## Deployment and verification

```powershell
npx.cmd --yes supabase db push --linked --dry-run
npx.cmd --yes supabase db push --linked
npx.cmd --yes supabase db query --linked --file supabase/tests/inventory_foundation.sql
npx.cmd --yes supabase db query --linked --file supabase/tests/bulk_inventory.sql
npx.cmd --yes supabase db lint --linked --level warning
npx.cmd --yes supabase db advisors --linked --type security --level warn --fail-on error
```

The integration test uses temporary Auth users inside a transaction and switches to actual authenticated and anonymous database roles. It verifies duplicate combining, whitespace/case normalization, title case, request retries, invalid requests, direct-write denial, negative/overflow rejection, zero-quantity preservation, shared household writes, owner-only membership, actor-only Undo, repeated Undo, preservation of later changes, failed-Undo rollback, cross-household isolation, and anonymous rejection. All fixtures are rolled back. This test exercises write behavior sequentially; it does not simulate simultaneous network clients.

The original deployment passed function lint and transactional integration checks. Its security advisor reported four warnings for intentionally authenticated-callable security-definer RPCs (`create_household`, `add_household_member`, `change_inventory`, `undo_inventory`), with no error-level findings. These RPCs are the controlled write boundary: direct table writes are revoked, and each RPC checks authentication, ownership, or membership before writing. Their elevated execution and explicit authorization are intentional; the warnings are retained for review rather than suppressed.

The default config references `supabase/seed.sql`; that file is intentionally empty so local resets do not create example food or personal accounts.

After the freezer refinement, the security advisor reports eight intentionally authenticated-callable security-definer RPCs, including the new freezer-save and move endpoints, and no error-level findings. Each new endpoint checks membership, locks the household, and verifies referenced freezer/item ownership. The private invitation table retains its intentional deny-all RLS configuration. The Auth leaked-password-protection warning is unchanged by this refinement.

The swap quantity is a noneditable number between minus/plus buttons, matching inventory rows. It defaults to one; minus stops at one and plus stops at current available stock. If stock drops while the dialog is open, the selection clamps to the new limit. Controls freeze during uncertain saves and retain the requested quantity for safe retry. The swap dialog uses native modal focus containment and Escape/Cancel behavior, shows current source stock, and validates the selected quantity before submission. Save errors and a retry action appear inside the dialog. Inputs freeze while a response is uncertain; a retry retains the original ID, destination, and quantity. Explicit database validation/access rejections unlock the dialog so the user can adjust it; current stock is refreshed after each attempt. Dialog success or cancellation restores focus to the triggering row when it still exists. The partial-swap database test covers remainder retention, destination combining, retry quantity mismatches, invalid/stale stock, source-at-zero retries, legacy callers, and atomic Undo preserving later changes. Browser tests cover keyboard/touch autocomplete, attached dropdown layout, dismissal without saving, modal cancellation, quantity validation, partial swap/Undo, and uncertain-response retries.

Freezer titles now use inline editing: the pencil icon replaces the selected title with a text field; blur or Enter saves through the existing save_freezer RPC, and Escape cancels. Whitespace is normalized, unchanged values skip writes, empty names stay editable with a validation error, and failed saves retain the draft with an inline error. Successful saves update the folder label and title without remounting inventory. The separate add-freezer form is used only for creating folders.

Compact layout refinement: the household name and household switcher are inside App settings. The inventory header’s two taglines are removed. A plus icon beside Your freezers opens freezer creation, and the single-item autocomplete form is always visible without entry-mode tabs. Browser tests now cover this compact surface rather than the removed bulk UI.
