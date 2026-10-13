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
  private networks, since there are no per-account quotas yet.

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

An ordinary notification can carry one HTTPS link to a report, artifact, file, or page:

```sh
relo notify "The architecture report is ready" --title "Codex" \
  --url "https://reports.example.com/architecture.html" \
  --project "Relo" --thread-name "Architecture review" --json
```

The URL is stored with the notification, delivered as APNs custom data, and shown with an attached
link indicator in the Dashboard and iOS Inbox. Opening the notification exposes the explicit link
action; tapping the system notification also routes to the validated HTTPS destination. Relo does
not download, inspect, or execute the target. Pergam pages, time-bounded MinIO links, Drive links,
and other HTTPS destinations use the same field. If a signed link expires, the notification remains
durable but the remote host decides whether the target is still available.

## Private remote access

Keep the API bound to `127.0.0.1` by default. For access away from the local network, put the host and
iPhone on the same Tailscale network, then expose the loopback service through
[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve):

```sh
tailscale serve --bg http://127.0.0.1:8180
tailscale serve status
```

Set `RELO_APP_URL` to the exact `https://…ts.net` origin printed by Serve and restart the API. Use
Serve, not Funnel: the endpoint should remain inside the tailnet. Do not expose port 8180 directly to
the public internet.

Relo does not require a public inbound endpoint, but APNs requires outbound Apple access.
