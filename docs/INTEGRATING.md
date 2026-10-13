# Integrating an app with Relo

An app, script or service asks the owner something on their iPhone and acts on the answer. It does
that through the `relo` CLI or the same HTTP API the CLI calls
([`docs/api/openapi.json`](api/openapi.json), generated from the server's request schemas). This page
covers what an integrator decides; [CHOICE-QUESTIONS.md](CHOICE-QUESTIONS.md) is the wire
specification for option questions.

## Contents

- [Sign in](#sign-in)
- [Identity: which card a command lands on](#identity-which-card-a-command-lands-on)
- [Asking](#asking)
- [Getting the answer: four ways](#getting-the-answer-four-ways)
- [Signed callbacks](#signed-callbacks)
- [Retries and idempotency](#retries-and-idempotency)
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

## Identity: which card a command lands on

Every card, question and notification carries a source, project and topic. The CLI fills source and
computer itself; the project defaults to the profile name (or the login's name when it is more than
the computer's name), and the topic is
the work as the owner would name it (`--topic "Nightly import"`).

- Starting again with the same topic joins the card already running instead of making a second one.
- Two processes that both want a card of their own pass `activity start --new`, or set
  `RELO_SESSION=<stable id>` per process.
- `relo ask --notification-only` skips the card and puts the question in Relo's Needs you.

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
  ends. A question that expires unanswered is a no.
- A phone that runs an older Relo cannot show options; such an ask is refused with
  `choice_unsupported` and nothing is sent.
- For phones this computer verified (`relo keys`), the CLI seals the question, its title and its detail
  before they leave the computer; option labels stay readable so the server can check the answer ([END-TO-END-ENCRYPTION.md](END-TO-END-ENCRYPTION.md)).

## Getting the answer: four ways

Pick by how your app runs. All four see the same answer; mixing them is fine.

| Your app | Use | How |
| --- | --- | --- |
| A script that can wait | **Block** | `relo ask …` waits (`--timeout`, default up to 5 minutes; 100s inside an agent session) and exits with the answer |
| A script that resumes later | **Wait by id** | `relo ask … --no-wait` prints the id; later `relo interaction wait ID --timeout 10m` |
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
 "respondedAt":"2026-10-13T09:14:02.511Z"}
```

Headers: `Authorization: Bearer <token>`, `Relo-Delivery-Id: cbk_…` (the same on every retry of one
answer: process each id once) and `Relo-Signature: t=UNIX,v1=HEX`, where HEX is HMAC-SHA256 keyed by
the token over `UNIX.BODY` (the raw body). Verify the signature with a constant-time comparison and
reject a `t` more than a few minutes old.

Answer with any 2xx. Anything else is retried after 30s, 2m, 10m and 1h. Expired or canceled
questions never call back, so treat silence past the expiry as no. Callbacks go to public HTTPS
addresses; private or local addresses work only when the server admin allows them.

## Retries and idempotency

Every command that creates something takes `--idempotency-key` (HTTP: the `Idempotency-Key` header).
Repeating a request with the same key returns the first result instead of a second card or question,
so after exit 6 (network) retry with the same key. Answers are recorded once; a second tap on another
device does not change them.

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
- **Cards per login** (Connections): at the limit a card start is refused with `card_limit_reached`
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
