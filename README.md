# Relo

Decentralized agents and automations, together in one place. Agents on any machine and harness,
scripts and scheduled jobs, and apps that need a human in the loop all report status, time-sensitive
alerts, details and questions to your iPhone. As more work runs on its own, Relo keeps it in view and
under your control, keeps it moving, and keeps it private: content is end-to-end encrypted on the
computer that sends it, the phone's keys rotate, and the server can wipe content after a few hours.
Why this matters: [docs/VALUE-PROPOSITION.md](docs/VALUE-PROPOSITION.md).

How it works: each source keeps one work current (a goal, a plan that grows, a status) that shows as
a Live Activity card on the Lock Screen and in the Dynamic Island, and asks approval or yes/no
questions right on it; notifications are reserved for finished outcomes. Sources send through the
`relo` CLI or the HTTP API to one server you run; PostgreSQL stores canonical state; a worker
delivers through APNs; the Dashboard and native iPhone app show history, decisions, and what needs
you now.

This repository is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE). Personal, educational, research, charitable, and
other noncommercial uses are permitted. Commercial use is not granted by this license. Because it
restricts commercial use, this is a source-available license rather than an OSI-approved open-source
license.

## What you need

For a complete installation that delivers to an iPhone, you need:

- a Linux or macOS host with Git, OpenSSL, Docker, and Docker Compose v2;
- Node.js 22 or newer on each computer that will run the `relo` CLI;
- a Mac with the current Xcode, a physical iPhone with Developer Mode enabled, and an active Apple
  Developer Program membership;
- an Apple Push Notification service key (`.p8`), its Key ID and Team ID;
- a unique iOS bundle ID and App Group; and
- one HTTPS origin reachable by the browser, the iPhone and every computer that runs the CLI.

You can run the server and Dashboard with APNs disabled, but remote notifications and Live Activity
updates will not reach the phone until the Apple and iOS steps are complete.

## Install Relo

### 1. Clone the repository

```sh
git clone https://github.com/redpanda77/relo.git
cd relo
```

### 2. Choose the address your iPhone will use

The default server listens only on `127.0.0.1:8180`. Pick one address for the browser, iPhone and
CLI; every install chooses its own, and each app asks for it at sign-in. It must be:

- HTTPS, reachable from every device that will use Relo (the iPhone app accepts plain `http` only
  for a private or local address, which suits a local trial); and
- served by something in front of Relo, so the API stays on loopback behind whatever terminates TLS.

Ways to get one:

- **A reverse proxy or tunnel** to `http://127.0.0.1:8180`: Cloudflare Tunnel, Caddy, nginx or
  Traefik. Set `RELO_CLIENT_IP_HEADER` so sign-in limits apply per client.
- **Your own domain** pointing at that proxy.
- **A VPN or overlay network** such as Tailscale or WireGuard, with HTTPS on the private name.
- **This computer only**, for a trial: `http://localhost:8180`.

Details and examples: [Choose an origin](docs/SELF-HOSTING.md#choose-an-origin).

### 3. Initialize secrets and configure the origin

```sh
./deploy/init-secrets.sh
```

Open `deploy/.env` and set `RELO_APP_URL` to the exact browser/iPhone origin chosen above. Do this
before creating the owner account. Keep `RELO_BIND_ADDRESS=127.0.0.1`; your proxy or tunnel reaches the
loopback listener.

The initializer creates protected PostgreSQL, Dashboard-authentication, and bootstrap-owner secrets.
Do not paste `deploy/secrets/owner_token` into the Dashboard; the server consumes it internally.

### 4. Start the server

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
curl --fail http://127.0.0.1:8180/health/ready
```

The first start creates PostgreSQL, applies migrations, creates the restricted runtime database
role, and starts the API and worker. Inspect failures with:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=200 api worker
```

### 5. Create the owner account

Open `RELO_APP_URL` in a browser. The first signup page says **Create the owner account**. Enter your
name, email, and a password of at least eight characters. This first account is the server's admin;
other people get separate, private accounts ([accounts](docs/SELF-HOSTING.md#accounts-and-the-server-admin)).
After that, `RELO_APP_URL` shows the Relo landing page; sign in with **Sign in** or at
`RELO_APP_URL/sign-in`.

### 6. Configure and build the iPhone app

Copy the local signing template:

```sh
cp apps/ios/Config/Signing.local.xcconfig.example \
  apps/ios/Config/Signing.local.xcconfig
```

Edit `Signing.local.xcconfig` and set:

- `DEVELOPMENT_TEAM` to the Apple Developer Team ID;
- `RELO_BUNDLE_ID` to a unique main App ID;
- `RELO_APP_GROUP` to the App Group shared by the app and its extensions; and
- optionally `RELO_API_ORIGIN` to your `RELO_APP_URL`, which pre-fills the server field. The app
  always lets the person signing in enter their own server. In the `.xcconfig` file, preserve
  Xcode's slash escape, for example `https:/$()/relo.example.com`.

Open `apps/ios/Relo.xcodeproj` in Xcode. Select the **Relo** scheme and connected iPhone, leave
automatic signing enabled for all three targets, and press **Run**. Direct Xcode builds use sandbox
APNs tokens.

On the iPhone, open Relo and tap **Sign in**. Approve in the browser, and you're back in the app.
Allow notifications, then confirm that the phone appears under **Connections → Phones**.

See [apps/ios/README.md](apps/ios/README.md) if Xcode cannot create the App ID, App Group, or
profiles.

### 7. Enable APNs delivery

Copy the Apple private key into the protected deployment directory:

```sh
cp /path/to/AuthKey_KEYID.p8 deploy/secrets/apns_key.p8
chmod 600 deploy/secrets/apns_key.p8
```

While `APNS_MODE` is still `disabled`, add the following values to `deploy/.env` from the exact Apple
Developer key record. Do not infer key scope or environment authorization from the `.p8` file.

```dotenv
APNS_MODE=disabled
APNS_TEAM_ID=YOUR_10_CHARACTER_TEAM_ID
APNS_KEY_ID=YOUR_10_CHARACTER_KEY_ID
APNS_TOPIC=com.example.relo.notifications
APNS_KEY_SCOPE=team-scoped
APNS_KEY_ENVIRONMENT=sandbox
APNS_DUAL_ENVIRONMENT_CONFIRMED=false
APNS_ASSOCIATED_TOPICS=
APNS_CONFIGURATION_GENERATION=initial
APNS_CUTOVER_AT=REPLACE_WITH_CURRENT_UTC_ISO_8601
```

`APNS_TOPIC` must equal `RELO_BUNDLE_ID`. Use `sandbox` for a direct Xcode build. Replace the example
cutover with the current UTC time from `date -u +"%Y-%m-%dT%H:%M:%SZ"`; it must not be in the future.
For a topic-specific key, set
`APNS_KEY_SCOPE=topic-specific` and copy its exact comma-separated associated topics.

Stop the disabled worker, record the cutover, then enable APNs:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml stop worker
docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm worker \
  node dist/apns-operations-cli.js cutover
```

Change `APNS_MODE=disabled` to `APNS_MODE=sandbox` in `deploy/.env`, then start the worker and verify
it remains healthy:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d worker
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
```

### 8. Install and authenticate the CLI

From the repository root, install the reviewed CLI directly from this checkout:

```sh
npm install --global ./packages/cli
relo --version
```

If you also change the CLI source, install a packed snapshot of a clean commit instead, so edits in
progress never reach the `relo` your agents run ([docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#the-cli-while-you-develop)).

In the signed-in Dashboard, open **Account → Connect the CLI** and copy the login command. It
contains the canonical `RELO_APP_URL` configured by this server, so the CLI does not need to guess
where your self-hosted instance lives. The equivalent command is:

```sh
relo auth login --api-url "https://your-relo-origin.example" \
  --client-name "My workstation" --json
```

Open the displayed verification URL, compare the code and requested scopes, then approve the client
in the signed-in Dashboard. The CLI always prints the complete one-time approval link and tries to
open it. If the browser cannot open, use the separately printed fallback page and code. On a remote
or headless computer, add `--no-open` and open the complete link on any browser that can reach the
same Relo server.

Denial, expiry, and timeout leave the computer unauthenticated; rerun the same login command to
create a fresh request. After approval, the protected local config retains both the exact server
origin and the scoped credential, so later commands know where to call. Confirm the live credential
and installation:

```sh
relo auth status --json
relo doctor --json
```

### 9. Send the first notification

```sh
relo notify "Relo is ready" \
  --title "First notification" \
  --project "Relo" \
  --topic "Installation check" \
  --json
```

The reply carries the notification `id` and the number of phones it targets (`devices`). Confirm the
notification appears in the Dashboard and on the iPhone. `relo test` asks once, on a short card,
whether you can see it on the iPhone. For a complete staged check, including a real smoke
notification, run:

```sh
relo doctor --smoke --json
```

Relo reports server acceptance, Apple acceptance, and phone receipt as separate facts; Apple
acceptance alone does not prove the phone displayed the notification.

### 10. Install the Agent Skill

The CLI carries the matching skill. Install it for each agent harness you use (one directory per
harness; `relo skill status` lists every copy and its version):

```sh
relo skill install --agent claude-code
relo skill install --agent codex
```

Without the CLI, install it straight from GitHub:

```sh
npx --yes skills@1.5.22 add redpanda77/relo@relo-notifications \
  --global --agent codex --yes
```

Restart the agent so it discovers the skill. Then ask:

> Use Relo to keep a live view of this task on my iPhone, and ask me before you finish.

The skill requires the independently installed and authenticated `relo` CLI. Installing the skill
does not deploy the server or create credentials. The agent reports with `relo work start`,
`update` and `finish`, and `relo state` shows what its session has open. See
[packages/cli/README.md](packages/cli/README.md).

### 11. Optionally enable hooks

Hooks are off unless you ask for them, and everything above works without them. With them, Relo also
knows when a session is working, waiting on you or stopped, reminds the agent of a work it forgot to
update, and restores its memory after compaction. They never change a work, plan or question, and no
prompt or tool content leaves the computer.

```sh
relo setup --project --hooks reminders   # local reminders only; sends nothing
relo setup --project --hooks presence    # reminders plus session presence
relo setup --project --hooks off         # remove them
```

See [docs/HOOKS-AND-HARNESSES.md](docs/HOOKS-AND-HARNESSES.md).

## Architecture in one minute

```text
CLI / agent / webhook / Dashboard / iPhone
                    │
                    ▼
             Hono API server
                    │ one transaction
                    ▼
        PostgreSQL state + outbox
                    │ leased jobs
                    ▼
              APNs worker ──► Apple ──► iPhone
                    ▲                       │
                    └── receipt / reply / sync ──┘
```

- The API owns authentication, validation, canonical state transitions, and the outbox. One server
  function derives what the owner sees (needs you, fresh or stale, shown or hidden) from what
  producers declare and what hooks observe; the apps only display it.
- PostgreSQL is the source of truth; provider acceptance is not phone receipt.
- The worker owns delivery attempts and retries. It does not own product state.
- The iPhone owns native presentation, local cache, ActivityKit, and authenticated receipts/replies.
- The CLI is the edge on each computer: it keeps each session's working copy, turns hook events into
  phases, seals content, and sends only changes through a durable outbox. The server is the clock,
  the aggregator, the deliverer and the authority.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for responsibilities, the state model and the
edge/server split.

## Privacy and security

Relo is designed so that what your agents tell you can be read only on the devices you paired.
The server, the person who runs it, its backups, and Apple's push service carry your content but
cannot read it, and they cannot forge your answer to a question.

**The design:**

- **End-to-end encryption.** The `relo` CLI seals every notification, question and Live Activity
  update to keys held in your iPhone's Secure Enclave. It uses HPKE (RFC 9180) with P-256 and
  AES-256-GCM, a standard scheme with no custom cryptography. The server stores and relays sealed
  envelopes and never holds a key that opens them.
- **Nothing to set up.** Like WhatsApp and Signal, a computer trusts the account's first iPhone the
  first time it sees its key. A phone added later waits until a trusted iPhone approves it
  (Settings → Devices) or you run `relo keys approve`, so a server cannot slip in a phone of its
  own. If a key changes, the phone and `relo keys status` show a "security code changed" notice.
  Comparing the 60-digit security code is an optional extra (`relo keys verify`, or Settings →
  Devices on the iPhone).
- **Answers are signed.** Approvals and replies are signed by the phone's device key. The CLI acts
  on an approval only when that signature verifies, so a compromised server cannot approve
  anything on your behalf.
- **Rotating keys and short retention.** Phones replace their receiving keys every 10 hours and
  delete the old private keys. The server deletes content after the window you set
  (`RELO_CONTENT_RETENTION_HOURS`, 10 recommended). Once the keys are gone, content cannot be
  opened, including copies taken before deletion.
- **Isolated accounts.** Each person on a server has their own account. The server admin manages
  accounts but cannot open them ([ADR 0004](docs/adr/0004-isolated-multi-user-accounts.md)).

**What stays visible:** the server always sees metadata. That means which phone and key is
involved, when something was sent, roughly how large it is, whether a card is active or ended,
whether a question was approved, and the name of the agent harness (such as "Claude Code").
Project, topic, computer and account names reach it only as opaque handles. Webhooks and other
producers that hold no Relo key cannot encrypt end to end; their content stays encrypted at rest on
the server and the phone labels it as not end-to-end encrypted. The web Dashboard shows
end-to-end-encrypted items as placeholders and handles.

**Status:** built and on by default once your iPhone runs a current build. Notifications,
questions and Live Activity cards are sealed on your computer. Project and topic names reach the
server only as opaque handles. Answers are signed, and the server deletes old content on a schedule
(`RELO_CONTENT_RETENTION_HOURS`, see [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md#content-retention)).
Webhooks and other producers without keys stay readable to the server and are labelled on the phone.
See [docs/END-TO-END-ENCRYPTION.md](docs/END-TO-END-ENCRYPTION.md) for the threat model, the
protocol and the current state of each phase.

## Development

Development requires Node.js 22+ and pnpm 11.20.0:

```sh
npm install --global pnpm@11.20.0
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

`scripts/gates.sh` runs the local gates in one go, and `scripts/gates.sh --db` adds the server
database suite on a throwaway PostgreSQL. The iPhone app has its own gate, `bash scripts/test-ios.sh`.
A skipped database suite is not a pass. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) and
[docs/TESTING.md](docs/TESTING.md).

## Documentation

- [ROADMAP.md](ROADMAP.md) — current outcome, priorities, and release sequence
- [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) — deployment and private-network notes
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system boundaries, the state model, the CLI/server split
- [docs/INTEGRATING.md](docs/INTEGRATING.md) — integrating an app or script: work, questions, callbacks, `relo listen`, exit codes
- [docs/HOOKS-AND-HARNESSES.md](docs/HOOKS-AND-HARNESSES.md) — optional hooks, their levels and privacy, adding a harness
- [docs/README.md](docs/README.md) — the full documentation index
- [docs/END-TO-END-ENCRYPTION.md](docs/END-TO-END-ENCRYPTION.md) — threat model, protocol, and
  rollout of end-to-end encryption
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution workflow
- [SECURITY.md](SECURITY.md) — private vulnerability reporting

## License

Relo is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). It permits use,
modification, and redistribution for noncommercial purposes. It does not grant commercial-use
rights.
