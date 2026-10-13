# Hardening a publicly reachable server

Relo can be served from a public address: a VPS, or a tunnel such as Cloudflare Tunnel. Relo's own
authentication must hold on its own there, because a proxy-level login (Cloudflare Access, a VPN) is
optional and many operators will not use one. This page lists what already protects a public
server and the gaps that are still open, in priority order. Each gap names the code it concerns.

## In place

- **The API stays on loopback.** Compose publishes `127.0.0.1:8180`; a proxy or tunnel reaches it,
  and public plaintext binding is rejected ([ADR 0006](adr/0006-operator-chosen-origin.md)).
- **Per-client limits behind a proxy.** `RELO_CLIENT_IP_HEADER` attributes requests to the real
  client, believed only from a loopback or private peer (`apps/server/src/client-address.ts`).
  Sign-in allows 10 attempts per client and 120 overall per minute, sign-up 5 and 30, CLI sign-in start
  10 and 40 (`auth-throttle.ts`, `device-authorization.ts`).
- **Request bodies are capped** at 1 MiB on every route, and HTTPS origins send HSTS (`app.ts`).
- **Registration is Closed** by default; the admin creates accounts.
- **Dashboard pages** send a strict CSP with `frame-ancestors 'none'`, `nosniff` and `no-store`
  (`web/http.ts`); cookies are `Secure` on an HTTPS origin.
- **Asset fetches** refuse private and reserved addresses and pin the resolved address
  (`presentation-assets.ts`).
- **Containers** run read-only, non-root, with all capabilities dropped; the API and worker use a
  restricted database role.
- **End-to-end encryption** keeps notice, question and card text unreadable to the server and to a
  TLS-terminating proxy ([END-TO-END-ENCRYPTION.md](END-TO-END-ENCRYPTION.md)).

## Open gaps

### 1. No second factor on accounts

An account is one email and password (minimum 8 characters, `account-auth.ts`). Anyone who learns
the password can sign in from anywhere. Plan: passkeys or TOTP for Dashboard sign-in, required for
the admin on a public origin, and a check against known-breached passwords.

### 2. Sign-in limits can be used to lock people out

The overall sign-in limit (120 per minute) slows distributed guessing, but an attacker who fills it
blocks everyone, the owner included. The limits are in memory, so a restart clears them. Plan:
per-account backoff that grows with failures, a separate budget for clients that have signed in
successfully before, and an optional challenge (for example Cloudflare Turnstile) after repeated
failures.

### 3. The iPhone trusts any new computer key

The phone pins every computer key the server lists, with only a notice for the second and later
ones (`apps/ios/Sources/ReloCore/E2EE/ReloTrustedClients.swift`, `autoTrust`). Someone with the
account password can create a CLI key and send readable-looking notices and questions that the phone
accepts. Plan: hold a new computer as pending until a trusted phone or computer approves it, the
way the CLI already holds new phones (`packages/cli/src/trust.mjs`).

### 4. The CLI re-trusts a changed phone key

When the key directory changes the identity key behind a pinned phone, the CLI pins the new key with
a "security code changed" notice unless `relo keys strict on` is set (`trust.mjs`). A compromised
server can therefore read new content and accept approvals signed by its own key. Plan: make strict
the default, so a changed key stays pending until approved from a trusted device.

### 5. Any CLI key can turn off the encryption requirement

`PUT /api/end-to-end/policy` accepts any CLI credential (`apps/server/src/api/device-routes.ts`).
The CLI's own fail-closed rule still holds, but a stolen key can change the server-side requirement.
Plan: require a Dashboard session, or a CLI key with an explicit admin scope.

### 6. "Open" registration on a public origin

Open registration with no per-account quotas lets anyone create accounts and consume server and APNs
capacity. Plan: refuse Open when `RELO_APP_URL` is a public address, or add quotas first.

### 7. Webhook secrets travel in the URL path

Service webhooks authenticate with a secret in `/hooks/:secret`, so the secret can appear in proxy
and CDN logs. Plan: accept the secret in a header and keep the path form for compatibility.

## Operator checklist for a public address

1. Use a long, unique password for every account until gap 1 is closed.
2. Keep registration Closed or Approval.
3. Set `RELO_CLIENT_IP_HEADER` to the header your proxy overwrites, never `x-forwarded-for`.
4. Run `relo keys strict on` on every computer.
5. Keep the API bound to `127.0.0.1` and reach it only through the proxy or tunnel.
6. Put a proxy-level login in front of the browser pages if your proxy offers one; see
   [Remote access](SELF-HOSTING.md#remote-access).
