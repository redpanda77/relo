# Hardening a publicly reachable server

Relo can be served from a public address: a VPS, or a tunnel such as Cloudflare Tunnel. Relo's own
authentication must hold on its own there, because a proxy-level login (Cloudflare Access, a VPN) is
optional and many operators will not use one. This page lists what protects a public server, the
gaps an audit found and how each was handled (every one is closed or an accepted trade-off), and
what an operator still has to do. Each item names the code it concerns.

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
- **Hooks hold a narrower credential.** A harness credential has the single scope `presence:write`,
  works only on `POST /api/agent-sessions/observed` (every other route refuses it, before the route
  runs), is rate limited per credential and per account, and is revoked by `relo hooks off`. The
  ordinary CLI credential cannot post observed state
  ([HOOKS-AND-HARNESSES.md](HOOKS-AND-HARNESSES.md#the-harness-credential)).
- **Request bodies are capped** at 1 MiB on every route, and HTTPS origins send HSTS (`app.ts`).
- **Registration is Closed** by default; the admin creates accounts.
- **Dashboard pages** send a strict CSP with `frame-ancestors 'none'`, `nosniff` and `no-store`
  (`web/http.ts`); cookies are `Secure` on an HTTPS origin. The CLI authorization page
  (`/cli/authorize`) runs its script only from `/cli/authorize.js`, under a CSP that allows no
  inline script (`device-authorization.ts`). A signed-out visitor is sent to `/sign-in?next=…`.
- **Asset fetches** refuse private and reserved addresses and pin the resolved address
  (`presentation-assets.ts`).
- **Containers** run read-only, non-root, with all capabilities dropped; the API and worker use a
  restricted database role.
- **New phones wait for a trusted phone.** A phone added after the first is *pending* until a
  trusted phone, or a browser a trusted phone linked, signs an approval; computers seal nothing to it
  until then ([END-TO-END-ENCRYPTION.md](END-TO-END-ENCRYPTION.md#new-devices-are-approved-on-a-trusted-phone)).
  A simulator never counts as that trusted phone and never receives approval notices.
- **End-to-end encryption** keeps notice, question and card text unreadable to the server and to a
  TLS-terminating proxy ([END-TO-END-ENCRYPTION.md](END-TO-END-ENCRYPTION.md)).

## Gaps found and how each was handled

### 1. No second factor on accounts (closed)

Closed on 14 October 2026: Account → Security → Two-step sign-in turns on codes from an
authenticator app (for example the Passwords app on iPhone), with ten one-time backup codes
(`account-auth.ts`, better-auth's two-factor plugin; migration 0095). After that, the password alone
signs in nowhere: the Dashboard, and the iPhone's sign-in that goes through it, ask for the code, and
the session comes only from `/api/auth/two-factor/verify-totp` or `verify-backup-code`, which keep the
sign-in limits (gap 2) and the disabled-account checks. "Don't ask again on this browser" lasts 30
days. The secret and backup codes are stored encrypted. Someone who loses both the authenticator and
the backup codes gets back in when the admin resets their password, which also clears two-step
sign-in. It is a per-account choice: turn it on for every account on a public address (checklist
below). Still possible later: passkeys, and a check against known-breached passwords.

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

### 4. The CLI re-trusts a changed or replaced phone (accepted trade-off)

By default the CLI follows WhatsApp: a changed identity key behind a pinned phone, and the account's
new phone once every phone it trusted has left the account, are trusted again with a visible notice
("security code changed", "phone set up again"; `packages/cli/src/trust.mjs`). A compromised server,
or anyone with the account password (gap 1), can therefore swap in its own phone key, read new
content and accept approvals signed by it. `relo keys strict on` holds both as pending until a
person runs `relo keys verify`. This is the owner's accepted trade-off (ADR 0005: Signal/WhatsApp-style
automatic trust, encryption always on); strict mode is the option for anyone who wants verification.

### 4a. A linked browser can approve a new phone (accepted trade-off)

Since 14 October 2026 the Dashboard's Account → Security → Devices can approve a pending phone from a
linked browser (`POST /api/dashboard/devices/:id/approve`, `device-approvals.ts`,
`approveDeviceFromBrowser`). The browser's non-extractable key signs the approval, but the server
serves the Dashboard's code, so a compromised server could make a linked browser approve a phone it
added itself. Mitigations: only a browser linked from a trusted, non-simulator phone in the last 14
days; the owner's session; a fresh authenticator code when two-step sign-in is on; 10 attempts per
account per 15 minutes; the CLI says "approved from <browser>"; and strict mode
(`relo keys strict on`) refuses browser approvals, leaving a phone's approval or `relo keys verify`.
Removing a phone from the Dashboard now also deletes what only that phone could open, like signing
out on it.

### 5. Any CLI key can turn off the encryption requirement (closed)

Closed on 14 October 2026: `PUT /api/end-to-end/policy` lets a CLI key only make the requirement
stricter (on, or auto); turning it off answers `turn_off_in_dashboard` and needs the owner signed in
to the Dashboard (`PUT /api/dashboard/end-to-end/policy`). A stolen CLI key can no longer weaken it.

### 6. "Open" registration on a public origin (closed)

Closed on 14 October 2026: when `APP_URL` is a public HTTPS address,
Open registration acts as Approval, and the admin page refuses to choose Open with
`open_registration_needs_private_origin` (`server-accounts.ts`, `registrationMode`). Open stays
available on a loopback or private origin.

### 7. Webhook secrets travel in the URL path (closed)

Closed on 14 October 2026: `POST /hooks` and `/hooks/live-activities…` take the secret in
`Authorization: Bearer hook_…` or `X-Relo-Webhook-Secret`, so it stays out of proxy, CDN and access
logs (`services.ts`, `registerHeaderSecretWebhooks`). The `/hooks/:secret` form keeps working for
existing integrations; prefer the header for new ones.

## Operator checklist for a public address

1. Use a long, unique password for every account, and turn on Two-step sign-in in Account →
   Security for each of them, the admin first.
2. Keep registration Closed or Approval (a public origin no longer allows Open).
3. Set `RELO_CLIENT_IP_HEADER` to the header your proxy overwrites, never `x-forwarded-for`.
4. Run `relo keys strict on` on every computer. After that, a changed key or a phone set up again
   needs `relo keys verify` before computers seal to it.
5. Keep the API bound to `127.0.0.1` and reach it only through the proxy or tunnel.
6. Put a proxy-level login in front of the browser pages if your proxy offers one; see
   [Remote access](SELF-HOSTING.md#choose-an-origin).
