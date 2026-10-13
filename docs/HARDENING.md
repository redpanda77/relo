# Hardening a publicly reachable server

Relo can be served from a public address: a VPS, or a tunnel such as Cloudflare Tunnel. Relo's own
authentication must hold on its own there, because a proxy-level login (Cloudflare Access, a VPN) is
optional and many operators will not use one. This page lists what already protects a public
server and the gaps that are still open, in priority order. Each gap names the code it concerns.

## In place

- **The API stays on loopback.** Compose publishes `127.0.0.1:8180` (`RELO_BIND_ADDRESS`); a proxy
  or tunnel reaches it. A public origin must be HTTPS: the server refuses to start with an
  `APP_URL` that is plain HTTP on a public address (`config.ts`), and the CLI refuses such an API URL
  ([ADR 0006](adr/0006-operator-chosen-origin.md)).
- **Per-client limits behind a proxy.** `RELO_CLIENT_IP_HEADER` attributes requests to the real
  client, believed only from a loopback or private peer (`apps/server/src/client-address.ts`); on the
  compose network that includes the other containers. Sign-in allows 10 attempts per client and 120
  overall per minute, sign-up 5 and 30, CLI sign-in start 10 and 40 (`auth-throttle.ts`,
  `device-authorization.ts`). A refused attempt is not counted, so a full limit empties a minute after
  the last accepted attempt.
- **Request bodies are capped** at 1 MiB on every route, and HTTPS origins send HSTS (`app.ts`).
- **Registration is Closed** by default; the admin creates accounts.
- **Dashboard pages** send a strict CSP with `frame-ancestors 'none'`, `nosniff` and `no-store`
  (`web/http.ts`); cookies are `Secure` on an HTTPS origin.
- **Asset fetches** refuse private and reserved addresses and pin the resolved address
  (`presentation-assets.ts`).
- **Containers** run read-only, non-root, with all capabilities dropped; the API and worker use a
  restricted database role.
- **New phones wait for a trusted phone.** A phone added after the first is *pending* until a
  trusted phone signs an approval; computers seal nothing to it until then
  ([END-TO-END-ENCRYPTION.md](END-TO-END-ENCRYPTION.md#new-devices-are-approved-on-a-trusted-phone)).
- **End-to-end encryption** keeps notice, question and card text unreadable to the server and to a
  TLS-terminating proxy ([END-TO-END-ENCRYPTION.md](END-TO-END-ENCRYPTION.md)).

## Open gaps

### 1. No second factor on accounts

An account is one email and password (minimum 8 characters, `account-auth.ts`). Anyone who learns
the password can sign in from anywhere. From the Dashboard they can also sign the owner's phone out
and sign in their own: computers trust it again with a "phone set up again" notice (gap 4), unless
strict mode is on. Sign-in also backs off per account (gap 2). Plan: passkeys or TOTP for Dashboard sign-in, required for
the admin on a public origin, and a check against known-breached passwords.

### 2. Sign-in limits can be used to lock people out (closed)

Closed on 14 October 2026 (`auth-throttle.ts`). After five wrong passwords for one email, that
account's next sign-in waits 1 second, doubling with each further failure up to 15 minutes; other
accounts are unaffected. A browser that has signed in to the account before carries a signed
`relo_known_device` cookie (HttpOnly, `Secure` on HTTPS) and skips both the account wait and the
overall limit, so someone guessing, or filling the limits on purpose, cannot lock the owner out of
their own browser. The limits and the cookie key are in memory: a restart clears both. A challenge
(for example Cloudflare Turnstile) can still be added in front of the proxy.

### 3. The iPhone trusts any new computer key (closed)

Closed on 14 October 2026: the computers present when the phone signs in are trusted on first use,
and any computer that appears after that is *pending* on the phone until the owner approves it in
Settings → Security (`apps/ios/Sources/ReloCore/E2EE/ReloTrustedClients.swift`). The server sends
the phones a plain "New computer wants access" notification when a second or later computer
publishes its key (`device-approvals.ts`, `announceNewComputer`). A trusted computer's changed key is
still trusted again with a notice (gap 4).

### 4. The CLI re-trusts a changed or replaced phone

By default the CLI follows WhatsApp: a changed identity key behind a pinned phone, and the account's
new phone once every phone it trusted has left the account, are trusted again with a visible notice
("security code changed", "phone set up again"; `packages/cli/src/trust.mjs`). A compromised server,
or anyone with the account password (gap 1), can therefore swap in its own phone key, read new
content and accept approvals signed by it. `relo keys strict on` holds both as pending until a
person runs `relo keys verify`. This is the owner's accepted trade-off (ADR 0005: Signal/WhatsApp-style
automatic trust, encryption always on); strict mode is the option for anyone who wants verification.

### 5. Any CLI key can turn off the encryption requirement (closed)

Closed on 14 October 2026: `PUT /api/end-to-end/policy` lets a CLI key only make the requirement
stricter (on, or auto); turning it off answers `turn_off_in_dashboard` and needs the owner signed in
to the Dashboard (`PUT /api/dashboard/end-to-end/policy`). A stolen CLI key can no longer weaken it.

### 6. "Open" registration on a public origin (closed)

Closed on 14 October 2026: when `APP_URL` is a public HTTPS address (a `*.ts.net` name counts),
Open registration acts as Approval, and the admin page refuses to choose Open with
`open_registration_needs_private_origin` (`server-accounts.ts`, `registrationMode`). Open stays
available on a loopback or private origin.

### 7. Webhook secrets travel in the URL path (closed)

Closed on 14 October 2026: `POST /hooks` and `/hooks/live-activities…` take the secret in
`Authorization: Bearer hook_…` or `X-Relo-Webhook-Secret`, so it stays out of proxy, CDN and access
logs (`services.ts`, `registerHeaderSecretWebhooks`). The `/hooks/:secret` form keeps working for
existing integrations; prefer the header for new ones.

## Operator checklist for a public address

1. Use a long, unique password for every account until gap 1 is closed.
2. Keep registration Closed or Approval (a public origin no longer allows Open).
3. Set `RELO_CLIENT_IP_HEADER` to the header your proxy overwrites, never `x-forwarded-for`.
4. Run `relo keys strict on` on every computer. After that, a changed key or a phone set up again
   needs `relo keys verify` before computers seal to it.
5. Keep the API bound to `127.0.0.1` and reach it only through the proxy or tunnel.
6. Put a proxy-level login in front of the browser pages if your proxy offers one; see
   [Remote access](SELF-HOSTING.md#remote-access).
