# Relo

Relo is a self-hosted developer notification and phone-decision system. Agents, CLIs, and webhooks
send work to one owner-operated server; PostgreSQL stores canonical state; a worker delivers through
APNs; the Dashboard and native iPhone app show durable history, decisions, and Live Activities.

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
- one HTTPS origin reachable by both the browser and iPhone. Tailscale Serve is the recommended
  private-network option.

You can run the server and Dashboard with APNs disabled, but remote notifications and Live Activity
updates will not reach the phone until the Apple and iOS steps are complete.

## Install Relo

### 1. Clone the repository

```sh
git clone https://github.com/redpanda77/relo.git
cd relo
```

### 2. Choose the address your iPhone will use

The default server listens only on `127.0.0.1:8180`. If the iPhone will connect through Tailscale,
install Tailscale on the server and phone, join both to the same tailnet, and configure Serve:

```sh
tailscale serve --bg http://127.0.0.1:8180
tailscale serve status
```

Keep the exact `https://…ts.net` origin printed by Tailscale. Use Serve, not Funnel; Relo should
remain private to the tailnet. A trusted local-network deployment may use another reachable origin,
but public plaintext HTTP is not supported by the iPhone app.

### 3. Initialize secrets and configure the origin

```sh
./deploy/init-secrets.sh
```

Open `deploy/.env` and set `RELO_APP_URL` to the exact browser/iPhone origin chosen above. Do this
before creating the owner account. Keep `RELO_BIND_ADDRESS=127.0.0.1` when using Tailscale Serve.

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
name, email, and a password of at least eight characters. Later visits use the same page to sign in;
Relo permits only one owner account.

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
- `RELO_API_ORIGIN` to the exact `RELO_APP_URL` origin. In the `.xcconfig` file, preserve Xcode's
  slash escape, for example `https:/$()/your-host.ts.net`.

Open `apps/ios/Relo.xcodeproj` in Xcode. Select the **Relo** scheme and connected iPhone, leave
automatic signing enabled for all three targets, and press **Run**. Direct Xcode builds use sandbox
APNs tokens.

In the Dashboard, open **Connections → Connect iPhone** and generate a QR code. Scan it from the
Relo sign-in screen, confirm the displayed origin, and allow notifications. Confirm that the phone
appears under **Connections → Phones**.

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

From the repository root, install the reviewed CLI and Codex integration directly from this
checkout:

```sh
npm install --global ./packages/cli ./packages/codex-notify
relo --version
```

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
  --thread-name "Installation check" \
  --json
```

The command must report at least one durable command. Confirm the notification appears in the
Dashboard and on the iPhone. For a complete staged check, including a real smoke notification, run:

```sh
relo doctor --smoke --json
```

Relo reports server acceptance, Apple acceptance, and phone receipt as separate facts; Apple
acceptance alone does not prove the phone displayed the notification.

### 10. Install the Agent Skill with `npx skills`

Install the skill globally for Codex directly from GitHub:

```sh
npx --yes skills@1.5.22 add redpanda77/relo@relo-notifications \
  --global --agent codex --yes
```

Contributors validating a local checkout can select the reviewed skill directory explicitly:

```sh
npx --yes skills@1.5.22 add ./skills/relo-notifications \
  --skill relo-notifications --global --agent codex --yes --copy
```

Restart Codex so it discovers the new global skill. Then ask:

> Use Relo to send my iPhone a test notification for this installation check.

The skill requires the independently installed and authenticated `relo` CLI. Installing the skill
does not deploy the server, create credentials, or alter agent hooks automatically. Optional Codex
lifecycle and permission-hook setup is documented in
[packages/codex-notify/README.md](packages/codex-notify/README.md) and
[packages/cli/README.md](packages/cli/README.md).

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

- The API owns authentication, validation, canonical state transitions, and the outbox.
- PostgreSQL is the source of truth; provider acceptance is not phone receipt.
- The worker owns delivery attempts and retries. It does not own product state.
- The iPhone owns native presentation, local cache, ActivityKit, and authenticated receipts/replies.
- The CLI and Agent Skill are clients of the same API; they do not duplicate server state machines.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for responsibilities and boundaries.

## Development

Development requires Node.js 22+ and pnpm 11.20.0:

```sh
npm install --global pnpm@11.20.0
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Swift package tests run separately:

```sh
cd apps/ios
swift test
```

Database suites require an isolated `TEST_DATABASE_URL`; a skipped database suite is not a pass.
See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Documentation

- [ROADMAP.md](ROADMAP.md) — current outcome, priorities, and release sequence
- [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) — deployment and private-network notes
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system boundaries and ownership
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution workflow
- [SECURITY.md](SECURITY.md) — private vulnerability reporting

## License

Relo is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). It permits use,
modification, and redistribution for noncommercial purposes. It does not grant commercial-use
rights.
