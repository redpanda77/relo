# Self-hosting Relo

Relo runs as an API, delivery worker, and PostgreSQL database. The supported starter profile is
[`deploy/compose.yaml`](../deploy/compose.yaml); it starts PostgreSQL, applies migrations, creates a
restricted runtime role, then starts the API and worker. It contains no maintainer hostnames, paths,
LAN addresses, signing identities, or bundle configuration.

## Start on a clean Docker host

```sh
./deploy/init-secrets.sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
curl --fail http://127.0.0.1:8180/health/ready
```

Review `RELO_APP_URL` before starting if the browser or iPhone reaches Relo through another HTTPS
origin. APNs begins disabled; configure it separately when ordinary notifications are required.
After Dashboard login and browser-approved CLI login, `relo doctor` checks the complete installation.
`relo doctor --smoke` also submits a notification without pretending that submission proves Apple
acceptance or phone receipt.

The disposable PostgreSQL test profile runs database suites with `TEST_DATABASE_URL` set, so they do
not silently skip:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile test run --rm integration-test
docker compose --env-file deploy/.env -f deploy/compose.yaml --profile test rm -sf postgres-test
```

Maintainer-specific operations remain outside this portable interface and the public source export.

## Accounts and the server admin

The first account created in the Dashboard owns the server and is its admin. Every other person
gets a separate, private account; the admin never sees their notifications, cards or phones
([ADR 0004](adr/0004-isolated-multi-user-accounts.md)). Under **Account → Server accounts** the
admin chooses how people join:

- **Closed** (the default): only the admin adds accounts, with a temporary password.
- **Approval**: anyone who can reach the server can register; they can sign in once approved.
  Each request reaches the admin from "Relo accounts" as a notification with Approve and Deny
  and, when the iPhone allows Live Activities, a card on the Lock Screen. Answering either one, or
  deciding in the Dashboard, settles both.
- **Open**: anyone who can reach the server can register and sign in at once. Keep this for
  private networks, since there are no per-account quotas yet; on a public HTTPS origin, Open acts
  as Approval.

The admin can also sign an account out everywhere, revoke its access (every session, CLI key,
service and phone stops working, and its data is kept), restore it, or delete it with all its
data. The iPhone signs in through the same web page, so registration and approval apply there too.

## Content retention

Set `RELO_CONTENT_RETENTION_HOURS` in `deploy/.env` to have the worker delete notification
content automatically, then restart the worker. Every five minutes it deletes notifications, their
sealed bodies, questions, replies and delivery records once they are older than the window. A
question still waiting for an answer, an active Live Activity, and the current item for a topic
are kept until they settle. A value of `10` matches the window used by end-to-end encryption
([plan](END-TO-END-ENCRYPTION.md)). Leave the variable empty to keep content until you run
`pnpm notification-retention` yourself.

Deleted notifications also leave the History that the iPhone loads from the server. Until the
phone keeps its own history (item E1.4 of the plan), a short window means a short History.

## Completion links and artifacts

An ordinary notification can carry one link to a report, artifact, file or page: an `https://` page,
an app scheme (`your-app://incidents/42`) or a Shortcuts link:

```sh
relo notify "The architecture report is ready" --title "Codex" \
  --url "https://reports.example.com/architecture.html" \
  --project "Relo" --topic "Architecture review" --json
```

The link is stored and delivered with the notification and shown with it in the Dashboard and on
the iPhone; tapping the notification opens it. Relo does not download, inspect or execute the
target. If a signed link expires, the notification remains, and the remote host decides whether the
target is still available.

## Choose an origin

`RELO_APP_URL` is the one origin browsers, the iPhone and the CLI use; every installation sets its
own, and both apps ask for it at sign-in. Change it, restart the API and worker, then sign in again
on each phone and computer. Relo does not care how you provide the origin, only that it meets this
checklist:

- Keep the API bound to `127.0.0.1` (`RELO_BIND_ADDRESS`); a proxy, tunnel or overlay service
  reaches the loopback listener.
- HTTPS with a certificate the iPhone trusts. The iPhone app accepts plain `http` only for
  `localhost`, `*.local`, loopback, link-local, and private (RFC 1918, `fc00::/7`) addresses
  (`ServerEndpointPolicy.swift`); use that only for a local trial.
- Reachable from every device that will use Relo: the browser, the iPhone and each computer that
  runs the CLI.
- Behind a proxy, set `RELO_CLIENT_IP_HEADER` to a header the proxy overwrites (never one a client
  can append to, such as `x-forwarded-for`). Without it every request appears to come from the
  proxy and per-client sign-in limits become one shared limit. The header is believed only from a
  loopback or private peer.
- If the proxy offers a login for the pages people open in a browser, use it; let the app, CLI and
  webhook paths through to Relo's own authentication.
- Keep registration **Closed** or **Approval** on a public address.

### Public: Cloudflare Tunnel and Access

A tunnel makes only outbound connections, so the host opens no inbound port:

```yaml
# cloudflared config for a named tunnel
ingress:
  - hostname: relo.example.com
    service: http://127.0.0.1:8180
  - service: http_status:404
```

Set `RELO_APP_URL=https://relo.example.com` and `RELO_CLIENT_IP_HEADER=cf-connecting-ip`. Without
the header every request appears to come from the tunnel, so per-client sign-in limits become one
shared limit. The header is believed only from a loopback or private peer.

Relo's own sign-in protects the server on its own; read [HARDENING.md](HARDENING.md) for what that
covers and what is still open. For an extra layer, put
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) in front of the
pages people open in a browser and let the app and CLI traffic through to Relo's own authentication
(Access matches the most specific path). Every person then also needs to be on the Access list:

| Path | Access policy |
|---|---|
| `relo.example.com` | Allow the people who use this server |
| `relo.example.com/api`, `/hooks` | Bypass (iPhone, Lock Screen answers, CLI, webhooks) |
| `relo.example.com/api/dashboard` | Allow |
| `relo.example.com/api/auth/sign-in`, `/api/auth/sign-up` | Allow |

The iPhone signs in through the same browser pages, so the Access login appears there once.
Leave Bot Fight Mode off for the hostname and bypass the cache. Event streams send a keepalive every
15 seconds, inside Cloudflare's idle timeout. Keep registration **Closed** or **Approval** on a
public address. Cloudflare terminates TLS: end-to-end sealed content stays opaque to it, while
credentials in transit and metadata do not ([what stays readable](END-TO-END-ENCRYPTION.md)).

### Any reverse proxy: Caddy

```caddyfile
relo.example.com {
    reverse_proxy 127.0.0.1:8180
}
```

Set `RELO_APP_URL=https://relo.example.com`. Caddy obtains the certificate itself. Set
`RELO_CLIENT_IP_HEADER` to a header your proxy overwrites with the client address (Caddy does not
add one by default; with a CDN in front, use the CDN's header). nginx and Traefik work the same way:
proxy to the loopback listener, keep long-lived event streams open (no response buffering, a read
timeout above 15 seconds).

### Private overlay network: Tailscale Serve

A VPN or overlay network keeps the origin off the public internet; the host and every device must
be on it. With [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) as the
example:

```sh
tailscale serve --bg http://127.0.0.1:8180
tailscale serve status
```

Set `RELO_APP_URL` to the exact `https://…` origin printed by Serve. Use Serve, not Funnel (Funnel
publishes it to the internet). WireGuard or another overlay with an HTTPS-terminating proxy works
the same way.

Relo needs no public inbound endpoint for APNs; it only makes outbound connections to Apple.
