# Freezer Inventory

A shared freezer inventory web app for two household members, opened from a QR code near the freezer.

## Development Roadmap

This is the original design plan and the reference for future development. Completion checks describe the intended outcome of each stage.

| Stage | What We Build | Completion Check |
| --- | --- | --- |
| 1. Core Inventory | Database tables, household access for both users, mobile inventory screen, single-item entry, title-case names, plus/minus controls, automatic combining, hide at zero, and Undo. | Both phones can add and remove items without duplicates or lost quantity updates. Undo restores the change, including a removal that reached zero. |
| 2. Faster Entry and Browsing | Previously used item suggestions, multiline bulk entry with editable preview, and a sort control with Name and Recently Changed options. | Restocking familiar foods takes minimal typing. Repeated names within a bulk entry also combine correctly. |
| 3. Automatic Organization and Search | Background AI tags and synonyms, reuse of previous tagging results, retries after failures, and search across names and generated metadata with typo tolerance. | “Chicken” finds chicken products, “vegetables” finds broccoli and green beans, and “snacks” finds appropriately tagged items. Saving never waits for AI. |
| 4. Cloudflare Launch and QR Access | Production deployment, persistent sign-in, phone home-screen installation, clear connection/save status, and a printable QR code pointing to the permanent app address. | Scanning the code on either phone opens the shared inventory, and changes appear on the other phone. |

Stage 1 is complete and accepted. The following refinements extend that original plan:

- **Textable invitations:** Profile icon → Share household → Copy invite link. Paste the link into a text message. It opens signup, preserves the invitation through email confirmation, and joins the household after authentication. Existing users can sign in to accept. Invitations remain single-use and expire after seven days.
- **Multiple freezers:** Each household has named freezer folders. Existing items are assigned to Main Freezer. Members can add freezers or rename one in place using the edit icon beside its title (click away to save), select a folder to view/add stock, and use **Freezer swap** to choose a destination and quantity in a dialog. Duplicate names combine within a freezer; the same food in different freezers has separate quantities. Moves support Undo.
- **Correct item names:** Use **Edit name** on an inventory row, or select a zero-stock name from autocomplete and choose **Edit saved name**. A new name renames the record; an existing name in the same freezer offers **Merge items** with a combined-quantity preview. Merging removes the old spelling from saved suggestions and preserves quantity Undo. Name corrections and merges themselves do not have an Undo button.
- **Automatic spelling:** On submission, obvious missing/doubled letters or adjacent letter swaps can reuse one unambiguous saved name. Unfamiliar names save immediately and receive a conservative spelling check in the same background AI call as their tags. Corrections show **Keep my spelling**, which restores that addition and remembers the choice. Quantity changes need no spelling-check call.

The current compact interface shows single-item entry with an autocomplete dropdown directly below Item name and Name/Recently Changed sorting. Household details and sharing live in the profile settings. Use the plus icon beside Your freezers to create another freezer. The bulk-entry interface and entry-mode tabs were removed at the user’s request to conserve space; the original roadmap above is retained as the design reference.

Development invite links use the configured LAN address and require access to that network. Replace it with the permanent HTTPS address and update the invite callback allowlist at launch.

## Database and Application Behavior

- **Zero-Quantity Items:** The underlying database will retain zero-quantity items for future suggestions and AI tag reuse.
- **Change History:** A small change history will support the Undo functionality.
- **Bulk Entry:** Bulk entry will be saved as a single operation, allowing Undo to reverse the entire batch.

## Main Screen Design

The main screen will remain simple and focused, containing:

- **Search:** Find inventory items quickly.
- **Add Items:** Add individual items or multiple items in bulk.
- **Sort Control:** Switch between Name and Recently Changed.
- **Inventory Rows:** Display each item with a **−** control to decrease quantity, a **quantity** display showing current stock, and a **+** control to increase quantity.

## Out of Scope

The following features are intentionally excluded from this development plan:

- Dates
- Barcode scanning
- Pictures
- Maps
- Manual category management

## Infrastructure

- Hosting: Cloudflare (deployment setup pending)
- Database: dedicated Supabase project, **Freezer Inventory**
- Supabase project reference: `olgldvjabjhxkbnfpcwh`
- Region: `us-east-2`

The database and interface support email/password authentication, Remember me, password reset, household setup, textable invitation links, multiple freezers, single/bulk item entry, previously used suggestions, Name/Recently Changed sorting, atomic plus/minus quantity controls, duplicate combining, and Undo. Phase three adds background AI tags/synonyms, cached results, bounded retries, and typo-tolerant search. Zero-quantity items stay in the database and disappear from the active list. Cloudflare deployment is pending. See [database architecture](docs/database.md), [authentication setup](docs/authentication.md), and [enrichment setup and costs](docs/enrichment.md).

## Run the app

```powershell
npm.cmd ci
Copy-Item .env.example .env.local
# Set the public Supabase key in .env.local, then:
npm.cmd run dev
```

Open `http://127.0.0.1:5173`. This computer already has an ignored `.env.local` configured. Do not overwrite it unless reconfiguring the project.

For phone testing, run `npm.cmd run dev -- --host 0.0.0.0` and open `http://192.168.4.44:5173/` on the same Wi-Fi. The address was checked during this chunk; check it again if the network changes.

```powershell
npm.cmd run build
npm.cmd test
npx.cmd playwright install chromium
npm.cmd run test:e2e
```

Cloudflare Pages can build with `npm run build` and publish `dist`. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as build variables. Configure the final Auth site URL and redirect allowlist before using confirmation or reset links in production.

## Supabase CLI

Run these commands in PowerShell from the repository directory:

```powershell
npx.cmd --yes supabase login --agent no --output-format text
npx.cmd --yes supabase link --project-ref olgldvjabjhxkbnfpcwh
npx.cmd --yes supabase projects list
```

CLI authentication is stored locally, outside the repository. The generated database password is encrypted for the current Windows user in `.local/supabase-db-password.dpapi`, which is excluded from Git. That file is machine/user specific and is not a portable backup; the password can be reset through Supabase if needed.

Keep database changes as versioned migrations under `supabase/migrations/` when implementation begins. Never commit access tokens, database passwords, or service-role keys.
