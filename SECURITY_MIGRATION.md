# Security hardening rollout

Apply `migrations/020_security_controls.sql` before deploying this version of
the API. The migration is additive; it does not remove existing orders,
verification records, users, or payments.

## Storefront compatibility changes

Most response shapes remain unchanged. The following security changes require
small storefront updates:

1. Guest tracking is now a two-step flow.
   - `POST /api/orders/track` with the existing order/contact body returns
     `202` and `tracking_request_id`.
   - Submit `tracking_request_id` and the six-digit `code` to
     `POST /api/orders/track/verify` (or back to `/api/orders/track`).
   - Store the returned `order_access_token` only for the current tab and send
     it in `x-order-access-token` as before.
2. Send the `checkout_id` returned by the first checkout-verification request
   on subsequent checkout-verification requests, verification confirmation,
   and in the create-order body. It is required for guest checkout and binds
   every proof to the same checkout.
3. Inspect invitations with `POST /api/auth/invitations/inspect` and
   `{ "invitation_token": "..." }`. The old token-bearing GET route now
   returns `410` so secrets no longer enter API access-log paths.
4. Use `POST /api/payments/checkout-sessions/result` with
   `{ "session_id": "..." }`. The former token-bearing GET route has been
   removed so Stripe session IDs do not enter API paths or access logs. Without
   the customer bearer token or guest order access token the POST response
   returns only non-identifying payment/order state; authorized callers also
   receive the order number and notification fields. Remove `session_id` from
   the browser URL immediately after reading it.
5. Customer email, SMS, or WhatsApp changes require a verification token with
   purpose `ACCOUNT_CONTACT_CHANGE`, supplied in `verification_tokens` on the
   profile update request. Removing an optional phone contact does not require
   a code.
6. Call `POST /api/auth/logout` before clearing local customer session state so
   the server session is revoked. Existing bearer-only sessions issued before
   deployment remain accepted until their normal expiry; new sessions enforce
   the configured idle timeout.

## New environment settings

- `JWT_EXPIRES_IN=30m`
- `CUSTOMER_IDLE_MINUTES=30`
- `CUSTOMER_SESSION_HOURS=24`

Production responses include HSTS. Confirm all subdomains are HTTPS before
adding the `preload` directive.
