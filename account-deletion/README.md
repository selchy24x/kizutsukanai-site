# Account deletion portal

Public URL after merging to `main`:

`https://selchy24x.github.io/kizutsukanai-site/account-deletion/`

This directory is a framework-free GitHub Pages application. It uses the
production Supabase publishable key; privileged operations stay in Edge
Functions.

## Backend release status

The matching `kizutsukanai_app` backend was deployed to production on
2026-07-26. It includes:

- migration `add_web_account_deletion_auth`
- `web-account-deletion-google-start`
- updated `google-oauth-callback`
- updated `social-auth-start` / `social-auth-callback`
- updated account-deletion challenge and start functions

The public page URL is registered in the Supabase Auth redirect allow list. The existing
Google OAuth callback URI remains unchanged because the deletion-only Google
flow reuses `google-oauth-callback` and distinguishes its server-side state.

The portal deliberately starts at STEP 1 on each new visit unless a durable
deletion status token is present. Email OTP, Google, LINE, and Yahoo! JAPAN ID
are always shown; there is no second login after the confirmation step.

## Safety properties

- Email OTP sets `shouldCreateUser` to `false`.
- Google, LINE, and Yahoo! resolve only existing app accounts.
- OAuth state and PKCE protect the Google flow; LINE and Yahoo! retain their
  existing state and nonce checks.
- A successful web login creates a ten-minute deletion verification record.
- The durable deletion status token is stored before the start request so a
  reload cannot strand the user outside the progress view.
