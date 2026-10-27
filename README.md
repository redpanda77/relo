# Relo

**Every agent, script and app you run, wherever it runs, in one place on your iPhone or your Mac.**

Your work no longer happens on one machine or in one tool. Claude Code on the laptop, Codex on another
computer, a nightly job on a home server, your own product waiting on a human decision. Each has its own
way of saying it is done, and its own way of getting stuck waiting for you. Relo brings all of it to one
place you already look at: your iPhone's Lock Screen and Dynamic Island, or your Mac's notch.

Every source, agent, script or app, can:

| | What it does | Where you see it |
|---|---|---|
| **Report status** | the goal, a plan that grows as the work does, the current step | a live card on the Lock Screen and in the Dynamic Island |
| **Break through when it matters** | time-sensitive alerts for what needs you now; everything else stays quiet | one notification per finished or failed outcome |
| **Carry the details** | the plan's steps, the specifics, what happened while you were away | the iPhone app and the web Dashboard |
| **Ask for your input** | approve, decline, answer yes/no or pick an option; no answer means no | right on the card, signed by your phone |

Run it on one Mac with **Relo for Mac** (nothing leaves the Mac, no server, no account), or on **a server
you own**, where content is **end-to-end encrypted** on the computer that sends it once an iPhone is
trusted: the server, its backups and Apple's push service carry your work but cannot read it.

Why it matters: [docs/VALUE-PROPOSITION.md](docs/VALUE-PROPOSITION.md).

## Why Relo

- **Visibility and control as automations take over.** The more you hand to agents and scripts, the more
  you need to see what they are doing and step in at the right moment. Nothing risky happens without your
  yes.
- **Work that keeps moving.** What is stuck, stale or waiting on you shows up before it costs hours, and
  every outcome, finished or failed, reaches you once.
- **Total privacy for confidential work.** Agents work on client code, unreleased plans and personal
  matters. Content opens only on your devices, the server wipes it after the window you set (10 hours by
  default), and your phone's keys rotate, so even an old copy can never be opened again.

## What it looks like

**An agent** reads one short block that `relo setup` writes for it, and keeps its card current:

```sh
relo work start --goal "Upgrade the payments SDK" --plan "Read the changelog,Update the calls,Run the tests"
relo work update --next-step --status "Updating the three checkout calls"
relo ask "Deploy to production?" --approval     # exit 0 with "approved" is the only yes
relo work deliver --outcome "SDK upgraded, all 214 tests pass, deployed"
```

**A script or cron job** needs one prefix. You see it while it runs, and a crash alerts you at once
instead of going quiet:

```sh
relo run --goal "Back up the photo library" -- rsync -a /photos /backup
```

**Your own app** needs only HTTP. Post an alert or a question to your server with a service secret, and
get the answer back by a signed callback:

```sh
curl -sS https://relo.example.com/hooks \
  -H "Authorization: Bearer $RELO_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"title":"Refund request","body":"Refund order 8812 (240 EUR)?",
       "context":{"project":"Shop","threadName":"Refunds"},
       "response":{"type":"approval","expiresInSeconds":7200,
                   "callback":{"url":"https://shop.example.com/relo/answers","token":"…"}}}'
```

### Works with the agents you already use

`relo setup` finds the harnesses on a computer and writes only what each one supports: a short
instructions block, the `relo-notifications` skill, and optionally hooks and an MCP entry. Claude Code,
Codex, Gemini CLI, Cursor, Copilot CLI, OpenCode, Amp and custom harnesses are covered; see
[Harnesses](docs/site/reference/harnesses.md). Each conversation is its own **session** with its own card,
and a session sees only its own work.

Hooks are optional and off by default. With them (`relo setup --level guide`), you also get a Sessions
view of what is working, waiting on you or idle, and `--approvals on` relays your agents' permission
prompts to the phone. Everything works without them.

## Get started

Two ways in. **Relo for Mac:** download the app, no server. **Your own server:** your server, this
computer, and optionally your iPhone, in about an hour. The full guide is in the docs, which every Relo
server also serves at `/docs`: [Get started](docs/site/get-started/index.md).

**Hand it to your coding agent.** Paste this into Claude Code, Codex or any agent. It runs the server,
waits while you create the owner account, connects this computer and points you to the iPhone app, asking
only what it must ([the guide](docs/site/get-started/from-scratch.md)):

```text
Read https://raw.githubusercontent.com/redpanda77/relo/main/docs/site/get-started/from-scratch.md and set up Relo for me.
```

**Or by hand:**

1. **[Run the server](docs/site/get-started/server.md)** on a Linux or macOS host with Docker: clone this
   repository, choose the HTTPS address your iPhone and computers will use, initialise secrets,
   `docker compose up -d`, and create the owner account in the browser. For a trial on one computer,
   `http://localhost:8180` is enough.
2. **[Connect this computer](docs/site/get-started/cli.md).** Right after the owner account, the
   Dashboard opens **Connect a computer**: one line in a terminal (or one message to your agent) installs
   the CLI, signs the computer in and sets up its agents. It brings Node.js 22 if the computer has none.
3. **[Add your iPhone](docs/site/get-started/iphone.md):** build the app from Xcode onto a physical
   iPhone, add your server, sign in, and turn on push delivery with your APNs key.
4. **[See your first card](docs/site/get-started/first-card.md):** `relo test`, then a real work with a
   plan, a question and an outcome.
5. **[Tell your agents](docs/site/get-started/agents.md):** restart them and say one sentence.

For the iPhone you need a Mac with Xcode, an iPhone with Developer Mode on, an Apple Developer Program
membership and an APNs key. The server, the Dashboard and your computers run without them; nothing
reaches the phone until they are done. Updates are one command: `relo update` keeps the CLI and its
skill current.

## Privacy and security

Relo is built so that what your agents tell you can be read only on the devices you paired, and nobody
but you can answer for you.

- **End-to-end encryption.** The CLI seals every notification, question and card update to your
  devices' keys with HPKE (RFC 9180, P-256, AES-256-GCM): a standard scheme, no custom cryptography. The
  phone's identity key lives in the Secure Enclave. The server stores and relays sealed envelopes and
  never holds a key that opens them.
- **Nothing to set up.** Like Signal and WhatsApp, a computer trusts the account's first iPhone the first
  time it sees its key. A device added later waits until a trusted iPhone approves it, so a server cannot
  slip in a phone of its own. A changed key shows a "security code changed" notice; comparing the
  60-digit security code is an optional extra (`relo keys verify`).
- **Signed answers.** Approvals and replies are signed by the phone's device key, and the CLI acts only
  when the signature verifies. A compromised server cannot approve anything on your behalf.
- **Rotating keys, short retention.** Phones replace their receiving keys every 10 hours and delete the
  old ones; the server deletes content after `RELO_CONTENT_RETENTION_HOURS` (10 by default). Once the
  keys are gone, content cannot be opened, including copies taken earlier.
- **Isolated accounts.** Each person on a server has their own account; the admin manages accounts but
  cannot open them ([ADR 0004](docs/adr/0004-isolated-multi-user-accounts.md)).

**What the server still sees:** metadata. Which device and key, when something was sent, roughly how
large it is, whether a card is active or a question was approved, and the harness's name ("Claude
Code"). Project, topic, computer and account names reach it only as opaque handles. Services that hold
no Relo key (webhooks) cannot encrypt end to end: their content is encrypted at rest and labelled on the
phone as not end-to-end encrypted. Threat model: [Encryption](docs/site/concepts/encryption.md);
protocol: [docs/ENCRYPTION-PROTOCOL.md](docs/ENCRYPTION-PROTOCOL.md).

## How it works

```text
 agents · scripts · apps
          │  relo CLI (seals, keeps local state, sends only changes)  or  HTTP API
          ▼
   Hono API server ──── one transaction ───► PostgreSQL: state + outbox
                                                   │ leased jobs
                                                   ▼
                                             APNs worker ──► Apple ──► iPhone
   Dashboard ◄── /api/now ── one derivation           ▲                  │
                                                      └── signed answers, receipts, sync
```

- **The CLI is the edge** on each computer. It keeps each session's working copy, turns optional hook
  events into session phases, seals content and sends only changes through a durable outbox, so a
  flaky network never blocks your agent.
- **The server is the clock, the aggregator, the deliverer and the authority.** One function derives
  what you see (needs you, fresh or stale, shown or hidden, how loudly to alert) from what producers
  declare and what hooks observe. The apps only draw it, so the iPhone and the Dashboard always agree.
- **Three sources of state, never mixed:** what a producer *declares* (goal, plan, status, question,
  outcome), what hooks *observe* (a turn running, a prompt waiting, a session ended) and what the
  server *derives*. Stale, stopped or broken items are kept off your screens, never shown as running.
- **PostgreSQL is the source of truth.** Delivery to Apple is not receipt on the phone; the phone
  confirms what it got.

More: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[ADR 0008](docs/adr/0008-relo-design-framework.md) (the design framework) and
[docs/site/how-it-works.md](docs/site/how-it-works.md).

## Repository layout

| Path | What it is |
|---|---|
| [`apps/server`](apps/server) | the Hono API, the derivation, the outbox worker and APNs delivery |
| [`apps/dashboard`](apps/dashboard) | the web Dashboard: Now, History, Sessions, accounts and setup |
| [`apps/ios`](apps/ios) | the native iPhone app, Live Activities and the notification service |
| [`packages/cli`](packages/cli) | the `relo` CLI, harness adapters, the MCP server and the bundled skill |
| [`packages/contracts`](packages/contracts) | the shared API contracts |
| [`deploy`](deploy) | the Docker Compose stack for self-hosting |
| [`docs`](docs) | the docs site, architecture, ADRs and protocols |

## Development

Node.js 22+ and pnpm 11.20.0:

```sh
npm install --global pnpm@11.20.0
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

`scripts/gates.sh` runs the local gates in one go; `scripts/gates.sh --db` adds the server database
suite on a throwaway PostgreSQL. The iPhone app has its own gate, `bash scripts/test-ios.sh`. A skipped
database suite is not a pass. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md),
[docs/TESTING.md](docs/TESTING.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [The Relo docs](docs/site/index.md), also served by every server at `/docs`: get started, concepts,
  guides, and the CLI and HTTP reference
- [Scripts, cron and CI](docs/site/guides/scripts.md) · [Apps and webhooks](docs/site/guides/apps.md) ·
  [Questions from code](docs/site/guides/asking.md) · [Depth and hooks](docs/site/guides/hooks.md)
- [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md): deployment, private networks, content retention
- [docs/INTEGRATING.md](docs/INTEGRATING.md): work, questions, callbacks, `relo listen`, exit codes
- [docs/HOOKS-AND-HARNESSES.md](docs/HOOKS-AND-HARNESSES.md): hook levels, their privacy, adding a harness
- [ROADMAP.md](ROADMAP.md): current outcome, priorities and release sequence
- [docs/README.md](docs/README.md): the full documentation index
- [SECURITY.md](SECURITY.md): private vulnerability reporting

## License

Relo is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE). Personal,
educational, research, charitable and other noncommercial use, modification and redistribution are
permitted; commercial use is not granted. Because it restricts commercial use, this is a
source-available license rather than an OSI-approved open-source license.
