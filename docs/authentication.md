# Authentication and household interface

## This chunk

React, TypeScript, Vite, and Supabase JS provide responsive sign-in, account creation, password reset, Remember me, household creation/joining, owner-generated invitations, sign-out, and read-only inventory. Item entry, plus/minus, Undo controls, contextual search, deployment, and QR generation remain later chunks. The current search filters item names only.

## Hosted configuration

Email/password authentication and signups are enabled. Email confirmation remains required. The hosted password minimum is eight characters. The development site URL is `http://127.0.0.1:5173`, with both `http://127.0.0.1:5173/` and `http://localhost:5173/` allowed as redirects.

`config/auth/supabase/config.toml` deliberately declares only the managed Auth properties. Use this small configuration to avoid pushing unrelated local-development settings:

```powershell
npx.cmd --yes supabase config diff --project-ref olgldvjabjhxkbnfpcwh --workdir config/auth
npx.cmd --yes supabase config push --project-ref olgldvjabjhxkbnfpcwh --workdir config/auth
```

Before deployment, replace the site URL with the permanent HTTPS origin and add its exact callback URL to the redirect allowlist. Preserve local redirects if local testing is still needed. Do not put a separate Cloudflare Access OTP gate in front of this app unless a second login is desired.

No personal accounts were created and no emails were sent during automated verification. Confirmation and reset email delivery must be verified with your real accounts. Supabase's default mail service has restrictions; if it will not deliver to both addresses, configure a custom SMTP provider before household onboarding. The UI and callback flow are covered with mocked Auth responses; that is not a live mail delivery test.

## Remember me

Checked stores the Supabase session in localStorage across browser visits. Unchecked uses sessionStorage, retaining a session on reload but keeping it out of persistent localStorage. Browsers may restore sessionStorage when restoring tabs, so closing the browser is not a guaranteed security logout. Use Sign out on shared devices.

Supabase refreshes short-lived access tokens using the saved refresh token. Remember me does not promise a fixed 30-day session; sessions can end after revocation, sign-out, policy changes, or cleared browser storage. Passwords are sent to Supabase over HTTPS and are never stored by this app. Sign-out uses local scope to sign out this browser rather than both household members or all devices.

Recovery redirects enter a dedicated password form, with a sessionStorage flag retaining that form across reloads. On successful password update the flag is cleared and the signed-in account enters household setup or inventory.

## Shared household

1. Both people create their own accounts and confirm their emails.
2. One person creates the household.
3. The owner selects Share household and creates an invitation code.
4. The other person signs in, selects Join your household, and pastes the code.

Codes use cryptographically random UUIDs. Only SHA-256 hashes are stored in a private table inaccessible to browser roles. Codes expire after seven days and are single-use, with retries allowed for the person who redeemed one. Replacing a code invalidates prior unused codes. Only the owner can issue codes. Household-first locking serializes invitation replacement and redemption with membership writes.

The original `add_household_member` RPC remains available for owner-authorized administration. The interface uses codes so users do not handle account UUIDs. Account creation alone grants no access to an existing household.

## Verification

Storage unit tests cover persistence selection, switching storage, and token cleanup. Terminal-driven Playwright tests mock the backend and cover sign-in, login failure, signup confirmation, password mismatch, password recovery callback/update, household creation/join, code generation, persistence across reload/new tabs, sign-out, and mobile viewport overflow. Desktop/mobile screenshots are generated in ignored `.local/` for visual review.

Database tests in `supabase/tests/household_invites.sql` use actual PostgreSQL roles and rollback all fixtures. They cover owner-only issuance, replacement, private-table access denial, redemption, retry, reuse rejection, expiration, and anonymous rejection.

```powershell
npx.cmd --yes supabase db query --linked --file supabase/tests/household_invites.sql
npx.cmd --yes supabase db lint --linked --level warning
```
