# Authentication and household interface

## This chunk

React, TypeScript, Vite, and Supabase JS provide responsive sign-in, account creation, password reset, Remember me, household creation/joining, owner-generated invitation links, sign-out, and inventory organized into named freezers. Single-item and bulk entry, previously used suggestions, Name/Recently Changed sorting, plus/minus, and Undo are implemented; see database.md for their behavior and verification. Contextual search, deployment, and QR generation remain later chunks. The current search filters item names only.

## Hosted configuration

Email/password authentication and signups are enabled. Email confirmation remains required. The hosted password minimum is eight characters. During Wi-Fi testing the hosted site URL is `http://192.168.4.44:5173`, with that address and both loopback addresses allowed as redirects. The ignored `.env.local` sets `VITE_AUTH_REDIRECT_URL=http://192.168.4.44:5173/` so emails requested from the PC can also open on a phone. Update this temporary address if the PC's IP changes. Production should use the final HTTPS address.

Successful signup replaces the signup form with a dedicated Check your email screen, including the submitted address, a resend action, and a return-to-sign-in action. Both signup and resend use the same callback URL, including a pending invitation when present. Supabase processes a confirmed signup callback. When it contains an invitation, the app redeems that invitation for the authenticated user and opens that household; otherwise it opens household setup or the existing inventory. Previously sent emails may still contain old redirect addresses; request a fresh email after a redirect change. If an older link already verified the account, sign in normally.

`config/auth/supabase/config.toml` deliberately declares only the managed Auth properties. Use this small configuration to avoid pushing unrelated local-development settings:

```powershell
npx.cmd --yes supabase config diff --project-ref olgldvjabjhxkbnfpcwh --workdir config/auth
npx.cmd --yes supabase config push --project-ref olgldvjabjhxkbnfpcwh --workdir config/auth
```

Before deployment, replace the site URL with the permanent HTTPS origin and add its exact callback URL to the redirect allowlist. Preserve local redirects if local testing is still needed. Do not put a separate Cloudflare Access OTP gate in front of this app unless a second login is desired.

No personal accounts were created and no emails were sent during automated verification. Confirmation and reset email delivery must be verified with your real accounts. Supabase's default mail service has restrictions; if it will not deliver to both addresses, configure a custom SMTP provider before household onboarding. The UI and callback flow are covered with mocked Auth responses; that is not a live mail delivery test.

During this chunk the user reported `email rate limit exceeded` on signup, so a fresh live confirmation return could not be verified. Existing confirmed accounts can sign in without requesting another email. Retry confirmation once the email quota recovers, or configure custom SMTP for continued email testing; keep email confirmation enabled. The LAN address remains `192.168.4.44`; the preview responded with HTTP 200 at the configured redirect URL. Automated signup callbacks still return to the signed-in app.

## Remember me

Checked stores the Supabase session in localStorage across browser visits. Unchecked uses sessionStorage, retaining a session on reload but keeping it out of persistent localStorage. Browsers may restore sessionStorage when restoring tabs, so closing the browser is not a guaranteed security logout. Use Sign out on shared devices.

Supabase refreshes short-lived access tokens using the saved refresh token. Remember me does not promise a fixed 30-day session; sessions can end after revocation, sign-out, policy changes, or cleared browser storage. Passwords are sent to Supabase over HTTPS and are never stored by this app. Sign-out uses local scope to sign out this browser rather than both household members or all devices.

Recovery redirects enter a dedicated password form, with a sessionStorage flag retaining that form across reloads. On successful password update the flag is cleared and the signed-in account enters household setup or inventory.

## Shared household

1. The owner opens the profile icon at the top right and selects **Share household → Copy invite link** and pastes it into a text message.
2. The recipient opens the link at `/?invite=<one-time-token>`, which opens account creation. Existing account holders choose Back to sign in.
3. Signup and confirmation-email resends include the invitation in `emailRedirectTo`, so opening the email in another browser/device retains it. Signup still requires email confirmation.
4. After authentication, the app calls `join_household` and selects the invited household. There is no invitation-code entry step for this flow.

The token is captured before removing it from the address bar and retained in localStorage for up to seven days so reloads and sign-in retain the invitation. This storage is independent of Remember me and holds an invitation, not an Auth session. It is cleared after joining, explicitly continuing without the invitation, or local expiration. The server enforces actual expiry, replacement, and one-time use. Expired/used links show the RPC error with a retry and a way to continue without joining.

Development callbacks allow the exact loopback and LAN roots plus `/?invite=*` patterns on those same origins. These patterns are deployed in the narrow Auth configuration. At launch replace the LAN origin with the permanent HTTPS address and add its invitation-query pattern. LAN invitation links only work while the recipient can reach that computer on the same network.

The button reuses the displayed invitation on repeated copies. **Replace invite link** explicitly invalidates older unused links. The Clipboard API has a selection-based fallback for LAN HTTP; if automatic copying is blocked, the read-only link remains available for manual copying. The app does not send text messages itself.

Links use cryptographically random UUID tokens. Only SHA-256 hashes are stored in a private table inaccessible to browser roles. Codes expire after seven days and are single-use, with retries allowed for the person who redeemed one. Replacing a code invalidates prior unused codes. Only the owner can issue codes. Household-first locking serializes invitation replacement and redemption with membership writes.

The original `add_household_member` RPC remains available for owner-authorized administration. The main sharing interface wraps codes in links so users do not handle account UUIDs. Manual code joining remains available for compatibility. Account creation alone grants no access to an existing household.

## Verification

Storage unit tests cover persistence selection, switching storage, and token cleanup. Terminal-driven Playwright tests mock the backend and cover sign-in, login failure, signup confirmation, password mismatch, password recovery callback/update, household creation/join, code generation, persistence across reload/new tabs, sign-out, and mobile viewport overflow. Desktop/mobile screenshots are generated in ignored `.local/` for visual review.

Database tests in `supabase/tests/household_invites.sql` use actual PostgreSQL roles and rollback all fixtures. They cover owner-only issuance, replacement, private-table access denial, redemption, retry, reuse rejection, expiration, and anonymous rejection.

```powershell
npx.cmd --yes supabase db query --linked --file supabase/tests/household_invites.sql
npx.cmd --yes supabase db lint --linked --level warning
```

Invitation browser tests additionally cover link copying without Clipboard API access, reuse on repeated copies, signup with an invitation callback, confirmation in a fresh browser with automatic household joining, reload/sign-in persistence, and expired-link errors. No live signup emails or texts were sent during automated checks; real email delivery remains subject to the previously observed sender rate limit.

The top-right profile icon opens App settings with the signed-in email, Sign out, and owner-only Share household. Invitation controls expand inside that settings panel. Escape or clicking outside closes the panel. Sign out retains local-browser scope.
