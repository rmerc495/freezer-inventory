# Stage 1 database architecture

Project: `olgldvjabjhxkbnfpcwh` (Freezer Inventory). PostgreSQL 17 on Supabase.

## Tables

| Table | Purpose |
| --- | --- |
| `households` | Shared inventory boundary and owner account. |
| `household_members` | Supabase Auth user IDs allowed to access a household. |
| `inventory_items` | Title-case display name, normalized duplicate key, whole-package quantity, creation and last-change timestamps. |
| `inventory_operations` | Actor, client-generated request ID, operation kind, request fingerprint, and reference to the operation being undone. |
| `inventory_changes` | Item-level before/after quantities for each operation. Supports multiple items per operation for a future bulk-entry RPC. |

All inventory references include the household ID, preventing a change from referencing another household's item or operation. Zero quantities remain stored for previously used suggestions. The main inventory query must filter `quantity > 0`; suggestions can include zero quantities. No food dates, tags, AI integrations, or bulk-entry endpoint are included in this stage.

## Access and onboarding

Users sign in with Supabase Auth. The first user calls `create_household`; it creates the household and their membership atomically. Once the second user has an Auth account, the owner can call `add_household_member` with that account's UUID. The app will need to provide the onboarding flow; no personal accounts or live household have been created by this migration.

Anonymous callers have no table or RPC access. Authenticated members can read only their households and related rows under row-level security. They cannot directly insert, update, or delete table rows. Writes use narrowly granted database functions that independently verify the caller's membership. The household owner alone can add members. User IDs come from the signed-in session, never from a caller-provided actor field.

Private helper functions are in a schema outside the configured Data API schemas. Security-definer functions have an empty search path and schema-qualified table references. These patterns follow the [Supabase function guidance](https://supabase.com/docs/guides/database/functions) and [row-level security guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Frontend RPC contract

Use a publishable Supabase key and the user's authenticated session. Never ship a database password or service-role key to the browser.

| RPC | Parameters | Result |
| --- | --- | --- |
| `create_household` | `p_name` (optional; defaults to Our Freezer) | Household UUID |
| `add_household_member` | `p_household_id`, `p_user_id` | No return value |
| `change_inventory` | `p_household_id`, `p_operation_id`, `p_delta`, either `p_name` or `p_item_id` | Operation UUID |
| `undo_inventory` | `p_household_id`, `p_operation_id` (original change), `p_undo_id` (new request ID) | Undo operation UUID |

For an addition, supply `p_name` and a positive integer delta, defaulting to one in the UI. The database trims and collapses whitespace, title-cases the display name, and combines items using a lowercase normalized name unique within the household. It does not merge synonyms, different punctuation, or different product descriptions. This deliberately keeps Chicken Thighs and Boneless Chicken Thighs separate.

For plus/minus, supply `p_item_id` and a delta of `1` or `-1`. Quantities cannot go below zero or exceed PostgreSQL's integer limit. A rejected operation changes neither inventory nor history.

Generate a request UUID once per intentional action and reuse it for retries. Repeating an identical request returns the existing operation without applying it twice. Reusing its ID with different input is rejected. Keep the returned operation ID for the Undo action.

## Undo and concurrency

All inventory RPCs lock the household row before applying changes. This serializes writes from both phones, including simultaneous duplicate adds, so counts are not overwritten. Each successful operation and its history are saved in one transaction.

Undo is a new, recorded compensating operation. It reverses only the original quantity delta, preserving later updates. Only the original actor can undo their operation, and only once; retrying the same Undo request is safe. Undo of an Undo is not supported. If reversing an earlier addition would make current stock negative, Undo is rejected atomically. The frontend should show that error instead of reporting success. The schema imposes no expiration time; the UI can show a short-lived Undo message.

Inventory items are included in Supabase Realtime. An authenticated subscription uses the same membership read policies. The frontend must fetch fresh data on reconnect and after mutation; zero-quantity updates should remove a row from the active list without deleting its database record.

## Deployment and verification

```powershell
npx.cmd --yes supabase db push --linked --dry-run
npx.cmd --yes supabase db push --linked
npx.cmd --yes supabase db query --linked --file supabase/tests/inventory_foundation.sql
npx.cmd --yes supabase db lint --linked --level warning
npx.cmd --yes supabase db advisors --linked --type security --level warn --fail-on error
```

The integration test uses temporary Auth users inside a transaction and switches to actual authenticated and anonymous database roles. It verifies duplicate combining, whitespace/case normalization, title case, request retries, invalid requests, direct-write denial, negative/overflow rejection, zero-quantity preservation, shared household writes, owner-only membership, actor-only Undo, repeated Undo, preservation of later changes, failed-Undo rollback, cross-household isolation, and anonymous rejection. All fixtures are rolled back. This test exercises write behavior sequentially; it does not simulate simultaneous network clients.

The deployment passed function lint and transactional integration checks. The security advisor reports four warnings for intentionally authenticated-callable security-definer RPCs (`create_household`, `add_household_member`, `change_inventory`, `undo_inventory`), with no error-level findings. These RPCs are the controlled write boundary: direct table writes are revoked, and each RPC checks authentication, ownership, or membership before writing. Their elevated execution and explicit authorization are intentional; the warnings are retained for review rather than suppressed.

The default config references `supabase/seed.sql`; that file is intentionally empty so local resets do not create example food or personal accounts.
