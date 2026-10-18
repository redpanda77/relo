# Integrating an app with Relo

An app, script or service shows its work on the owner's iPhone, asks the owner something and acts on
the answer. It does that through the `relo` CLI or the same HTTP API the CLI calls
([`docs/api/openapi.json`](api/openapi.json), generated from the server's request schemas). This page
covers what an integrator decides; [CHOICE-QUESTIONS.md](CHOICE-QUESTIONS.md) is the wire
specification for option questions. Agent sessions and their hooks are not integrations: an agent
reports with `relo work` through its skill, and hooks are described in
[HOOKS-AND-HARNESSES.md](HOOKS-AND-HARNESSES.md).

## Contents

- [Sign in](#sign-in)
- [Producer types](#producer-types)
- [Reporting work](#reporting-work)
- [Asking](#asking)
- [Getting the answer: four ways](#getting-the-answer-four-ways)
- [Signed callbacks](#signed-callbacks)
- [Retries and idempotency](#retries-and-idempotency)
- [HTTP routes and scopes](#http-routes-and-scopes)
- [Exit codes](#exit-codes)
- [Limits the server admin controls](#limits-the-server-admin-controls)
- [When access ends](#when-access-ends)

## Sign in

Each app gets its own login: `relo auth login` prints a URL the owner approves in the browser, and
the CLI stores the token in its protected config. Several logins live side by side as profiles
(`relo auth login --profile billing`, then `RELO_PROFILE=billing relo …` or `relo auth switch
billing`). CI and containers set `RELO_TOKEN` and `RELO_API_URL` instead. Never pass a token as a flag
or print it.

Everything a login asks belongs to the owner's account and only that account: other accounts on the
same server cannot see it ([ADR 0004](adr/0004-isolated-multi-user-accounts.md)).

## Producer types

Relo keeps declared work (what a producer says it is doing) separate from observed session state and
from derived policy ([ADR 0007](adr/0007-presence-messages-work-separation.md),
[ADR 0008](adr/0008-relo-design-framework.md)). Each producer type has its own identity and surface;
one cannot call another's.

| Type | Identity | Surface |
| --- | --- | --- |
| Agent session (Claude Code, Codex) | the harness's session id, read by the CLI | `relo work` and `relo state` inside the session; see the skill |
| Script (CLI or API key, no harness) | the login plus a producer key you choose | `relo work … --producer KEY`, `relo ask`, `relo listen` |
| App or service (HTTP) | a login with scopes, or a service secret | the HTTP routes below; signed answer callbacks |
| Harness hooks | a separate harness credential | observed phase snapshots only, never work |

The server derives what the owner sees (attention, freshness, visibility, urgency) from the declared
work and the observed evidence. A producer cannot set those.

## Reporting work

A script or app declares one goal at a time as a work: a goal, an optional plan of named steps, a
status line and an outcome. The owner sees it on the Lock Screen and in Now while it is current.

```bash
relo work start --producer nightly-import --goal "Import yesterday's orders" \
  --plan "Download,Validate,Load" --lease 15m --idempotency-key import-2026-10-14
relo work update --producer nightly-import --status "Validating 4,200 rows" --next-step
relo work heartbeat --producer nightly-import --lease 15m
relo work finish --producer nightly-import --outcome "4,200 orders imported"
```

- **The producer key** (`--producer`, or `RELO_SESSION` for a process that has no agent harness)
  names the job (1-100 characters of `A-Z a-z 0-9 . _ : -`). Later commands with the same key find
  the same work. There is no guessing: without a key the command is refused.
- **One open work per producer key.** Starting again continues it; `--new` parks the open one (it
  stays readable) and starts another. Every start needs `--idempotency-key`: a retry returns the same
  work.
- **Plans grow in place.** `--plan "A,B"` lists what is left (done steps stay), `--add` appends,
  `--next-step` and `--step` move on, `--progress 3/20` attaches a count to the current step.
  Steps are named milestones in order; placeholders such as "Step 2" or "todo" are refused.
- **Leases keep it fresh.** A script says how long it may stay silent (`--lease`, 1 minute to 60
  minutes, default 15). While the lease holds, the work counts as moving; after it lapses the normal
  freshness rules apply: dimmed after 20 minutes without a write, off the Lock Screen after 60. A
  heartbeat renews the lease and declares nothing else.
- **Finishing is explicit.** `finish --outcome "…"` is required; add `--failed` or `--dropped` when
  it did not succeed. The outcome is the notification. Open steps become skipped.
- **Pausing** (`pause --status "…"`) hides the work; `resume` brings it back.
- **A script's work is sealed** like an agent's when the computer trusts a phone: the server stores
  `{sealed: true}` in place of the goal, status, outcome and step labels, and the card carries the words
  ([ENCRYPTION-PROTOCOL.md](ENCRYPTION-PROTOCOL.md)). On an account that requires end-to-end
  encryption, readable script text is refused (`end_to_end_required`). A service posting over HTTP
  cannot seal: its text is readable, and a plain string is read as readable text.

Over HTTP a script's work lives under `/api/producers/{producerKey}/works` (`producerKey` is the
base64url SHA-256 of `producer:` plus the readable key; the CLI computes it). A service holding a
`hook_…` secret uses `/hooks/works`, the secret in `Authorization: Bearer hook_…`, with `producerKey` in the start body. Both take
`Idempotency-Key` on create and answer `{ "work": …, "disposition": … }`. A service's work gets
its card like a script's: it starts, advances its steps and ends with the work.

A script's card is its work's card: `relo activity start` and `relo activity update` are gone, so a
script declares its work with `relo work start --producer KEY` and the server shows it. The
`/api/live-activities` routes remain for apps and services that post a card of their own over HTTP,
and the owner keeps `relo activity end|status|get|list|diagnose` (and `relo admin activity …`).

Every card, question and notification also carries a source, project and topic. The CLI fills source
and computer itself; the project defaults to the profile name, and the topic is the work as the owner
would name it (`--topic "Nightly import"`). `relo ask --notification-only` skips the card and puts the
question in Relo's Needs you.

## Asking

```bash
relo ask "Deploy 2.4 to production?" --approval --topic "Release 2.4" \
  --detail "Adds offline mode. Migration 0042 rewrites orders (about 30s read-only). Undo: rollback 0042."
relo ask "Which region goes first?" --option EU --option US --option Both --topic "Release 2.4"
```

- **Answers are taps, never typed text.** `--approval` (Approve/Deny), `--yes-no`, or 2-4 `--option`
  labels (up to 24 characters each). Only an `approval` answered `approved` is permission; a yes or a
  picked option is a preference.
- **The question is one line of at most 120 characters**, self-contained, because the owner may answer
  from the Lock Screen. It is never shortened; a longer one is refused.
- **The explanation goes in `--detail`**: markdown, up to 4,000 characters, shown with the question in
  Relo, never on the card or the notification.
- **How long it stays open**: `--expires-in` (default 5 minutes, for example `2h` or `3d`) up to the
  admin's limit. A card lives at most 8 hours; a longer question keeps waiting in Relo after the card
  ends. A question that expires unanswered is a no. A question on an open work never ends that work.
- **A question never starts a card.** On a running card it shows on that card; otherwise it goes out
  as a notification with the answer buttons.
- **One question at a time per card.** Asking on a card that is already waiting is refused with
  `question_pending`: wait for the answer or cancel it first. A card update that asks a new question
  cancels the pending one.
- **Late answers are facts, not permission.** If the owner answers after the question expired, it
  stays `expired` and carries the answer in `late` (`relo interaction get ID`). The owner can also
  dismiss a missed question, which refuses a late answer.
- A phone that runs an older Relo cannot show options; such an ask is refused with
  `choice_unsupported` and nothing is sent.
- For phones this computer verified (`relo keys`), the CLI seals the question, its title and its detail
  before they leave the computer; option labels stay readable so the server can check the answer ([ENCRYPTION-PROTOCOL.md](ENCRYPTION-PROTOCOL.md)).

## Getting the answer: four ways

Pick by how your app runs. All four see the same answer; mixing them is fine.

| Your app | Use | How |
| --- | --- | --- |
| A script that can wait | **Block** | `relo ask …` waits (`--timeout`, default up to 5 minutes; 100s inside an agent session; the CLI asks in slices of at most 90 seconds) and exits with the answer |
| A script that resumes later | **Wait by id** | `relo ask … --no-wait` prints the id; later `relo interaction wait ID --timeout 10m` (also sliced) |
| A service with a public HTTPS endpoint | **Callback** | `relo ask … --no-wait --callback-url https://… --callback-token-file PATH`; Relo POSTs the answer |
| A service behind NAT, or many questions | **Listen** | `relo listen` streams one JSON line per answer over one outgoing connection |

`relo listen` prints `{id,eventId,state,option?,label?,correlationId?,respondedAt,cursor}` for every
question this login asked, oldest first. Store the last `cursor` and restart with `--since CURSOR`
to continue without losing or repeating an answer; `--since 2026-10-13T09:00:00Z` starts from a time,
`--once` prints what is waiting and exits. It reconnects after network errors and stops with exit 3
when the login stops working. Over HTTP it is `GET /api/interactions/answers?after=CURSOR&timeoutSeconds=60`.

Pass `--correlation-id` (your own reference, up to 100 characters) to match an answer to your record;
every method echoes it.

## Signed callbacks

Relo POSTs JSON to the callback URL once the question settles:

```json
{"type":"notification.response","eventId":"ntf_…","interactionId":"int_…","correlationId":"order-81",
 "kind":"choice","status":"replied","action":"choose","optionId":"eu","label":"EU","text":null,
 "respondedAt":"2026-10-13T09:14:02.511Z","device":{"id":"dev_…","keyId":"…"},"signature":{…}}
```

`signature` is the phone's own signature over the answer, passed through untouched (it is `null`
for a phone without published keys). When you answered from a linked browser, `device.id` is its
`brw_…` id and `signature` is the browser's, over the same input; trust it only while a phone you
trust linked that browser ([Answering from a linked browser](ENCRYPTION-PROTOCOL.md#answering-from-a-linked-browser)). A verifying receiver trusts the phone, not the server
([ADR 0005](adr/0005-end-to-end-encrypted-content.md)).

Headers: `Authorization: Bearer <token>`, `Relo-Delivery-Id: cbk_…` (the same on every retry of one
answer: process each id once) and two signatures over the same body, so use whichever your stack
verifies:

- `Relo-Signature: t=UNIX,v1=HEX`, where HEX is HMAC-SHA256 keyed by the token over `UNIX.BODY`
  (the raw body).
- [Standard Webhooks](https://www.standardwebhooks.com): `webhook-id` (equal to `Relo-Delivery-Id`),
  `webhook-timestamp` and `webhook-signature: v1,BASE64`, an HMAC-SHA256 over `ID.TIMESTAMP.BODY`.
  A token that starts with `whsec_` is keyed by its base64-decoded bytes; any other token by its
  UTF-8 bytes.

Verify with a constant-time comparison and reject a timestamp more than a few minutes old.

Answer with any 2xx. Anything else is retried after 30s, 2m, 10m, 1h, 3h, 6h, 12h, then daily, ten
attempts in all and never past 72 hours from the first. A `410` stops retries at once. Expired or
canceled questions never call back, so treat silence past the expiry as no, and reconcile with
`relo interaction get ID` (HTTP: `GET /api/interactions/{id}`) when you restart. Callbacks go to
public HTTPS addresses. A private address (where plain `http://` is accepted) works only when the
server admin allows it; the server's own loopback, link-local and metadata addresses never do.

## Retries and idempotency

Every command that creates something takes `--idempotency-key` (HTTP: the `Idempotency-Key` header).
Repeating a request with the same key returns the first result instead of a second card or question,
so after exit 6 (network) retry with the same key. Answers are recorded once; a second tap on another
device does not change them.

## HTTP routes and scopes

[`openapi.json`](api/openapi.json) is the contract. Send `Authorization: Bearer <login token>`; each
route needs the scope shown.

| Route | Scope | Purpose |
| --- | --- | --- |
| `POST /api/notifications` | `notifications:send` | One-off notification |
| `POST /api/interactions`, `GET …/{id}`, `GET …/{id}/wait`, `POST …/{id}/cancel` | `interactions:create`, `interactions:read` | Ask, read, wait, withdraw |
| `GET /api/interactions/answers` | `interactions:read` | Answer feed with cursors |
| `POST /api/producers/{producerKey}/works`, then `GET`, `PATCH`, `…/pause`, `…/resume`, `…/finish`, `…/heartbeat` | `activities:write` | A script's or app's work |
| `POST /hooks/works` and the same sub-routes | the service secret, in a header | A service's work |
| `/api/live-activities…` | `activities:write` | Cards without a work |
| `GET /api/devices` | `devices:read` | The account's phones |

Routes for the other types are not for integrators and refuse a producer's credential:

- `/api/session/works…` is an agent session's own work (the CLI sends the session key from the
  harness).
- `POST /api/agent-sessions/observed` accepts only a harness credential, whose single scope is
  `presence:write`; every other route refuses it. `GET /api/agent-sessions` lists sessions for the
  owner (`activities:read`).
- `POST /api/harness-credentials`, `GET` and `DELETE …/{id}` mint, list and revoke harness
  credentials (`services:write`, `services:read`).
- `GET /api/works` and `GET /api/now` are the owner's reads; `/api/now` is the one place clients get
  derived state, and the Dashboard and the apps only display it.

## Exit codes

| Code | Meaning | Do |
| --- | --- | --- |
| `0` | Done; for a question, answered (approved, yes, or an option) | Read `state`: only `approved` is permission |
| `1` | Server or other failure | Report; retry later |
| `2` | Usage error | Fix the command; the hint shows a corrected one |
| `3` | Login missing, refused or lacking scope | See [When access ends](#when-access-ends) |
| `4` | Still open: this command stopped waiting | `relo interaction wait ID` |
| `5` | The owner denied or said no | Do not act |
| `6` | Network unreachable | Retry with the same idempotency key |
| `7` | No phone could receive it | `relo doctor` |
| `8` | Closed without an answer (expired, canceled) | Do not act |

Output is one JSON line on stdout (`--json` keeps it machine-readable); errors are
`{"ok":false,"error":{"code","message","hint"}}`.

## Limits the server admin controls

Set in the Dashboard by whoever owns the server:

- **Longest question wait** (Server): 7 days by default, up to 30. A longer `--expires-in` is refused
  with `question_wait_too_long`, which names the limit.
- **Private callback addresses** (Server): nobody, the admin only, or everyone.
- **Cards per computer** (Connections → Computers): at the limit a card start is refused with `card_limit_reached`
  and `relo ask` falls back to a question in Needs you (the output says so in `note`).
- **Who may have an account** (Server): open sign-up, admin approval, or closed.

## When access ends

A refused login says why, with exit 3:

| Code | Meaning | Do |
| --- | --- | --- |
| `ACCOUNT_DISABLED` | The admin turned the account off | Stop; retrying will not help |
| `CREDENTIAL_REVOKED` | The owner revoked this login | Stop; sign in again only if the owner wants it back |
| `LOGIN_EXPIRED` | The login expired | `relo auth login` |
| `UNAUTHORIZED` | Unknown token | Check `RELO_TOKEN` / the profile |
