# Freezer Inventory

A shared freezer inventory web app for two household members, opened from a QR code near the freezer.

## Infrastructure

- Hosting: Cloudflare (deployment setup pending)
- Database: dedicated Supabase project, **Freezer Inventory**
- Supabase project reference: `olgldvjabjhxkbnfpcwh`
- Region: `us-east-2`

The database project has been provisioned. Application code and inventory tables have not been created yet.

## Supabase CLI

Run these commands in PowerShell from the repository directory:

```powershell
npx.cmd --yes supabase login --agent no --output-format text
npx.cmd --yes supabase link --project-ref olgldvjabjhxkbnfpcwh
npx.cmd --yes supabase projects list
```

CLI authentication is stored locally, outside the repository. The generated database password is encrypted for the current Windows user in `.local/supabase-db-password.dpapi`, which is excluded from Git. That file is machine/user specific and is not a portable backup; the password can be reset through Supabase if needed.

Keep database changes as versioned migrations under `supabase/migrations/` when implementation begins. Never commit access tokens, database passwords, or service-role keys.
