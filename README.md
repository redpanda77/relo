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

## Install Relo

The full guide is in the docs, which every Relo server also serves at `/docs`:
[Get started](docs/site/get-started/index.md). In short:

1. **[Run the server](docs/site/get-started/server.md)** on a Linux or macOS host with Docker: clone
   this repository, choose the HTTPS address your iPhone and computers will use, initialise secrets,
   `docker compose up -d`, and create the owner account.
2. **[Install the iPhone app](docs/site/get-started/iphone.md)** from Xcode on a physical iPhone, sign
   in, and turn on push delivery with your APNs key.
3. **[Connect this computer](docs/site/get-started/cli.md)**: install the CLI release (Node.js 22+),
   `relo auth login`, then `relo doctor`.
4. **[See your first card](docs/site/get-started/first-card.md)**: `relo test`, then a real
   `relo work start`, `relo work update` and `relo work deliver` (then `relo work finish` when the goal is done).
5. **[Tell your agents](docs/site/get-started/agents.md)**: `relo setup` writes a short block and the
   skill for every agent harness on the computer. Hooks and MCP are optional.

You need a Mac with Xcode, an iPhone with Developer Mode, an Apple Developer Program membership and an
APNs key for push delivery; the server runs with push disabled until then.

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
  update to your iPhone's keys (its identity key lives in the Secure Enclave; its receiving keys
  rotate). It uses HPKE (RFC 9180) with P-256 and
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
  (`RELO_CONTENT_RETENTION_HOURS`, 10 hours by default in the deploy files; `relo doctor` shows it). Once the keys are gone, content cannot be
  opened, including copies taken before deletion.
- **Isolated accounts.** Each person on a server has their own account. The server admin manages
  accounts but cannot open them ([ADR 0004](docs/adr/0004-isolated-multi-user-accounts.md)).

**What stays visible:** the server always sees metadata. That means which phone and key is
involved, when something was sent, roughly how large it is, whether a card is active or ended,
whether a question was approved, and the name of the agent harness (such as "Claude Code").
Project, topic, computer and account names reach it only as opaque handles. Webhooks and other
producers that hold no Relo key cannot encrypt end to end; their content stays encrypted at rest on
the server and the phone labels it as not end-to-end encrypted. The web Dashboard shows
end-to-end-encrypted items as placeholders unless the browser is linked from your iPhone.

**Status:** built and on by default once your iPhone runs a current build. Notifications,
questions and Live Activity cards are sealed on your computer. Project and topic names reach the
server only as opaque handles. Answers are signed, and the server deletes old content on a schedule
(`RELO_CONTENT_RETENTION_HOURS`, see [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md#content-retention)).
Webhooks and other producers without keys stay readable to the server and are labelled on the phone.
See [Encryption](https://github.com/redpanda77/relo/blob/main/docs/site/concepts/encryption.md) for the threat model and
[docs/ENCRYPTION-PROTOCOL.md](docs/ENCRYPTION-PROTOCOL.md) for the protocol.

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

- [docs/site](docs/site/index.md) — the Relo docs (served by every server at `/docs`): get started,
  concepts, guides and the CLI and HTTP reference
- [ROADMAP.md](ROADMAP.md) — current outcome, priorities, and release sequence
- [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) — deployment and private-network notes
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system boundaries, the state model, the CLI/server split
- [docs/INTEGRATING.md](docs/INTEGRATING.md) — integrating an app or script: work, questions, callbacks, `relo listen`, exit codes
- [docs/HOOKS-AND-HARNESSES.md](docs/HOOKS-AND-HARNESSES.md) — optional hooks, their levels and privacy, adding a harness
- [docs/README.md](docs/README.md) — the full documentation index
- [docs/ENCRYPTION-PROTOCOL.md](docs/ENCRYPTION-PROTOCOL.md) — keys, message formats and signing
  inputs of end-to-end encryption
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution workflow
- [SECURITY.md](SECURITY.md) — private vulnerability reporting

## License

Relo is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). It permits use,
modification, and redistribution for noncommercial purposes. It does not grant commercial-use
rights.
