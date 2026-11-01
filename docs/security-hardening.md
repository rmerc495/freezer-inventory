# Security hardening — November 1, 2026

## Changes

- Household invitations require a verified recipient email. The legacy `create_household_invite(uuid)` RPC is removed. Unused unbound invitations are deleted; consumed unbound tokens also fail redemption. Existing memberships are preserved.
- `public/_headers` ships a Content Security Policy, framing denial, MIME sniffing protection, a no-referrer policy, restricted browser permissions, and HSTS. Script execution is restricted to this origin. Network connections allow this origin and this project's Supabase HTTPS/WebSocket endpoints. Google Fonts styles and font files remain allowed for the existing design.
- `config/auth/supabase/config.toml` uses only the production HTTPS Site URL, root callback, and invitation-query pattern. LAN and loopback callbacks are excluded from hosted configuration. Local development settings remain in `supabase/config.toml`.

## Rollout status

The email-only migration was applied to hosted Supabase and verified with rollback-only database tests. Its file version matches the hosted migration history. No unused unbound invitations existed at application time; existing memberships were not removed.

The browser headers take effect when the updated build is deployed to the existing Cloudflare Workers Static Assets site. Vite copies `_headers` into `dist`; Cloudflare applies that file to static asset responses. A custom Worker that creates responses must apply equivalent headers itself.

The hosted Auth configuration could not be pushed from this cloud environment because the Supabase CLI has no access token. From an authenticated CLI session, run:

```sh
supabase config push --project-ref olgldvjabjhxkbnfpcwh --workdir config/auth --yes
```

Alternatively set Site URL to `https://freezer-inventory.ryanmercier88.workers.dev/` and the redirect allowlist to just these two entries in Supabase Auth URL Configuration:

```text
https://freezer-inventory.ryanmercier88.workers.dev/
https://freezer-inventory.ryanmercier88.workers.dev/?invite=*
```

Remove old HTTP/LAN/loopback entries. Preserve other Auth properties. Ensure production builds do not override `VITE_AUTH_REDIRECT_URL` with a development address. After rollout, request fresh signup, password-reset, and recipient invitation emails to verify actual callback delivery; no emails were sent during automated tests.

## Verification

The production build and all 30 unit tests passed. All 38 existing browser tests passed. The additional production-bundle CSP browser test passed after allowing the app's existing Google Fonts; it checks sign-in, response headers, absence of CSP violations during normal use, and actual blocking of an injected inline script.

Run the browser tests after building with the Supabase URL and a public key configured (a dummy publishable key is sufficient for mocked tests):

```sh
npm ci
npm test
npm run build
npm run test:e2e
```

Both `supabase/tests/household_invites.sql` and `supabase/tests/email_household_invites.sql` passed in separate rollback-only transactions against the updated hosted database. They cover legacy token rejection, private-table denial, recipient verification, owner-only issuance, cooldown, repeated acceptance, and anonymous denial.

The post-migration advisor reports no error-level findings. The intentional authenticated privileged-function notices decreased from 14 to 13. The pre-existing disabled leaked-password protection warning remains outside this change's scope.
