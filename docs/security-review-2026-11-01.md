# Security review — November 1, 2026

Reviewed the repository, the deployed Cloudflare site, and live Supabase project `olgldvjabjhxkbnfpcwh`. No production settings or application data were changed. Database role tests ran inside rolled-back transactions.

## Assessment

No unauthenticated household-data exposure was found in the checks performed. Direct API calls are possible by design, but the database enforces household membership independently of the interface. This is a focused review, not a guarantee that all vulnerabilities have been excluded.

## Verified protections

- All seven public application tables have RLS enabled. Anonymous users lack SELECT privileges; authenticated users lack direct INSERT/UPDATE/DELETE privileges.
- SELECT policies require current database household membership. Spelling notices additionally require the current actor. Authorization does not depend on editable user metadata.
- A simulated authenticated identity with no household membership saw zero rows across households, members, inventory, operations, changes, freezers, and spelling notices.
- Representative inventory-write and invitation-creation RPC calls as that outsider were rejected. These probes used a nonexistent target household; they do not replace exhaustive tests using two real households.
- Reviewed live privileged RPC definitions: household operations check membership, invitations and member administration check ownership, and worker RPCs deny browser roles. Functions have an explicit empty search path.
- Email-bound invitations require the recipient's verified Auth email. Invitation tokens are hashed in a private table, expire after seven days, and are single-use.
- Calls to the deployed inventory and household REST endpoints using the browser publishable key, without a session, returned HTTP 401. Both Edge Functions also returned 401 without authorization.
- Live Auth settings require email confirmation and disable anonymous sign-ins. Public account creation is enabled; creating an account does not grant access to an existing household.
- No public storage buckets exist.
- No complete Supabase secret-key or OpenAI project-key literals were found in the deployed JavaScript by the targeted scan. The SDK contains the text `sb_secret_` as a key-type check; this is not a leaked credential. This was not an exhaustive historical secret scan.
- `npm audit --omit=dev` reported zero known production dependency vulnerabilities for the committed lockfile.

## Recommended hardening

1. **Enable leaked-password protection.** The live Supabase advisor reports this disabled. This reduces account-takeover risk from known compromised passwords. Consider a longer password minimum and MFA as well; MFA is not implemented in the reviewed UI.
   Reference: https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection
2. **Retire legacy unbound invitations if only named recipients should join.** `create_household_invite` remains callable by the owner, and `join_household` accepts an unexpired unbound token from any authenticated holder. A forwarded or stolen legacy link can therefore grant membership. Email invitations already bind redemption to a verified address. Disable the legacy issuance path and invalidate unused unbound tokens when moving to email-only access. Membership granted through the older path also needs an administrative review; no memberships were changed here.
3. **Add browser security headers.** The deployed HTML response had no Content-Security-Policy, frame protection (`frame-ancestors` or X-Frame-Options), Referrer-Policy, or X-Content-Type-Options. Session tokens are stored in browser storage, making script injection especially consequential. Use a tested CSP with explicit script/connect sources, block framing, and add `nosniff` and an explicit referrer policy. No script-injection exploit was demonstrated.
4. **Reconcile production Auth configuration with the repository.** `config/auth/supabase/config.toml` still sets an HTTP LAN Site URL and LAN/loopback redirects. This file is not evidence of the current hosted values. Confirm the live Site URL is the production HTTPS origin and remove unnecessary HTTP callback destinations before reapplying this configuration.
5. **For a private family app, consider closing public registration after onboarding.** This reduces signup abuse and resource consumption; it is not necessary for the existing household RLS protections. Any change must preserve the desired administrator email invitation flow.

The advisor's 14 authenticated SECURITY DEFINER warnings identify sensitive, intentionally callable RPCs. The reviewed authorization checks matter more than the warning count; moving them or revoking their execute permission indiscriminately would break application writes. The four private-table RLS-without-policy notices reflect deny-by-default access, not open access.

## Privacy and limits

The enrichment worker sends item names to OpenAI with `store: false`. This is intentional third-party processing and is separate from whether strangers can access the database. That flag alone does not establish a zero-retention agreement.

This review did not exhaustively test two real household accounts, stolen or revoked sessions, all RPC argument combinations, historical credentials, hosted SMTP/Auth administration settings, or the deployed Edge Function source against the repository. No accounts were created and no invitation emails were sent. A stolen authorized session can act with that user's permissions; RLS does not protect against account takeover.

Anyone can load the public login page and inspect its JavaScript, project URL, and publishable key. Those values are designed to be public. If the requirement is to hide the website itself, an additional access gateway is needed. A gateway on the Cloudflare site alone does not prevent direct calls to Supabase, so database authorization must remain in place.
