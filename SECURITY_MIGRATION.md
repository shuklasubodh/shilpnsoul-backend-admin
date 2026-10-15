# Security hardening rollout

Apply `migrations/020_security_controls.sql` and then
`migrations/021_browser_and_admin_sessions.sql` before deploying this version
of the API. Migration 021 adds CSRF-bound browser and administrator sessions.
It also expires outstanding unaccepted ADMIN invitations so privileged users
must receive a new one-hour invitation using the hardened flow.

## Storefront compatibility changes

Most response shapes remain unchanged. The following security changes require
small storefront updates:

1. Guest tracking is now a two-step flow.
   - `POST /api/orders/track` with the existing order/contact body returns
     `202` and `tracking_request_id`.
   - Submit `tracking_request_id` and the six-digit `code` to
     `POST /api/orders/track/verify` (or back to `/api/orders/track`).
   - The API stores the order capability in an HttpOnly order-scoped cookie.
     Keep the returned `order_access_csrf_token` in the current tab and send it
     in `x-csrf-token` for guest mutations.
2. Send the `checkout_id` returned by the first checkout-verification request
   on subsequent checkout-verification requests, verification confirmation,
   and in the create-order body. It is required for guest checkout and binds
   every proof to the same checkout.
3. Inspect invitations with `POST /api/auth/invitations/inspect` and
   `{ "invitation_token": "..." }`. The old token-bearing GET route now
   returns `410` so secrets no longer enter API access-log paths.
   - New invitation emails use `#invitation=...`, preventing the token from
     being sent in the initial HTTP request. Continue accepting and immediately
     clearing the legacy query form only while old customer links expire.
   - ADMIN invitations expire after one hour and require an email OTP in
     addition to any configured SMS or WhatsApp verification.
4. Use `POST /api/payments/checkout-sessions/result` with
   `{ "session_id": "..." }`. The former token-bearing GET route has been
   removed so Stripe session IDs do not enter API paths or access logs. Without
   the customer session cookie or guest order cookie the POST response
   returns only non-identifying payment/order state; authorized callers also
   receive the order number and notification fields. Remove `session_id` from
   the browser URL immediately after reading it.
5. Customer email, SMS, or WhatsApp changes require a verification token with
   purpose `ACCOUNT_CONTACT_CHANGE`, supplied in `verification_tokens` on the
   profile update request. Removing an optional phone contact does not require
   a code.
6. Customer authentication uses a `Secure`, `HttpOnly`, `SameSite` cookie.
   Send fetch requests with credentials and include the returned CSRF token in
   `x-csrf-token` on state-changing requests. Call `POST /api/auth/logout`
   before clearing local state so the server session and cookie are revoked.
7. Administrator tokens now contain a server-session id. Every admin request
   rechecks the current database role, active state, idle timeout, and absolute
   session expiry. Admin logout revokes that session immediately.

## New environment settings

- `JWT_EXPIRES_IN=30m`
- `CUSTOMER_IDLE_MINUTES=30`
- `CUSTOMER_SESSION_HOURS=24`
- `AUTH_COOKIE_SAME_SITE=lax` (`none` only for genuinely cross-site API hosting)
- `TRUST_PROXY=1` (set only for the known deployment topology)
- `ADMIN_JWT_EXPIRES_IN=30m`
- `ADMIN_IDLE_MINUTES=15`
- `ADMIN_SESSION_HOURS=8`

Production responses include HSTS. Confirm all subdomains are HTTPS before
adding the `preload` directive.
