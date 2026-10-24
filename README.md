# Freezer Inventory

A shared freezer inventory web app for two household members, opened from a QR code near the freezer.

## Infrastructure

- Hosting: Cloudflare (deployment setup pending)
- Database: dedicated Supabase project, **Freezer Inventory**
- Supabase project reference: `olgldvjabjhxkbnfpcwh`
- Region: `us-east-2`

The Stage 1 database schema and the first interface chunk are implemented: email/password authentication, Remember me, password reset, household setup, invitation codes, and a read-only inventory screen. Item entry and quantity controls are the next chunk. Cloudflare deployment is pending. See [database architecture](docs/database.md) and [authentication setup](docs/authentication.md).

## Run the app

```powershell
npm.cmd ci
Copy-Item .env.example .env.local
# Set the public Supabase key in .env.local, then:
npm.cmd run dev
```

Open `http://127.0.0.1:5173`. This computer already has an ignored `.env.local` configured. Do not overwrite it unless reconfiguring the project.

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
