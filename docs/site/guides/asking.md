---
title: Questions from code
nav: Questions from code
summary: Your script, job or app stops before a risky step, asks you on your iPhone, and acts only on an approval.
---

## Why

Some steps should not happen without you: a production deploy, a restore over live data, a refund.
`relo ask` puts the question on the job's card (or, with no card running, sends it as a notification
with answer buttons). You answer with a tap from the Lock Screen. The code waits, or picks the answer up
later, and carries on.

:::never Only approved is permission
Act only when an `--approval` question returns exit 0 with state `approved`. Denied, no, expired,
canceled, a timeout, an error or unreadable output all mean no. A yes to a yes/no question, a chosen
option, or a late answer after expiry is a preference or a fact, never permission.
:::

## Three kinds of question

```sh
# permission for one exact action: Approve / Deny
relo ask "Deploy 2.4 to production?" --approval \
  --detail "Adds offline mode. Migration 0042 locks orders for about 30 s. Undo: roll back 0042."

# a plain question: Yes / No
relo ask "Keep the old export files?" --yes-no

# a choice: 2 to 4 options
relo ask "Which region goes first?" --option EU --option US --option Both
```

- The question is one line of at most 120 characters, readable on its own from the Lock Screen. A longer
  one is refused, never shortened.
- The why, the risk and the undo go in `--detail`: Markdown up to 4,000 characters, shown with the
  question in Relo.
- Option labels are one line of up to 24 characters. `--option eu=EU` sets the id you get back.
- One exact action per approval. If the action changes, ask again.

Every flag: [questions reference](/docs/reference/cli/questions). How questions look and expire:
[Questions](/docs/concepts/questions).

## Wait for the answer

By default `relo ask` blocks and exits with the answer:

```sh
if relo ask "Restore last night's backup over production?" --approval \
     --expires-in 30m --timeout 30m --idempotency-key "restore-$(date +%F)"; then
  ./restore.sh
fi
```

- `--expires-in` is how long the question stays answerable (default {{fact question.defaultSeconds}}, up to your server's
  limit). Past {{fact card.maxSeconds}} the card ends and the question waits in Relo.
- `--timeout` is how long this command waits (at most the question's life). Inside an agent session or a
  script with `RELO_SESSION`, the default is {{fact question.agentWaitSeconds}}, because shell tools kill long commands.
- `--idempotency-key` makes a retry return the same question instead of asking twice.

| Exit | Means | Do |
| --- | --- | --- |
| 0 | approved, yes, or an option chosen | read the state: only `approved` is permission |
| 5 | denied or no | stop |
| 4 | still open: this command stopped waiting | resume with `relo interaction wait ID` |
| 8 | closed without an answer (expired, canceled) | do not act |

Every other code: [exit codes](/docs/reference/exit-codes).

## Pick the answer up later

A job that should not block can ask and move on:

```sh
relo ask "Publish the March report?" --approval --expires-in 4h --no-wait
# prints the question's id (int_…); later, from any step:
relo interaction wait int_123 --timeout 10m
```

`relo interaction get ID` reads the state without waiting, and `relo interaction cancel ID` withdraws a
question you no longer need. A question on a card is one at a time: wait for it or cancel it before
asking the next.

## Callbacks

A service with a public HTTPS endpoint can have the answer posted to it instead of polling:

```sh
relo ask "Refund order 8812 (240 EUR)?" --approval --expires-in 2h --no-wait \
  --callback-url https://shop.example.com/relo/answers \
  --callback-token-file /etc/shop/relo-callback-token \
  --correlation-id order-8812
```

- Relo POSTs the answer as JSON with `Authorization: Bearer <token>`, signed with the token
  (`Relo-Signature`, and Standard Webhooks headers). Verify the signature and process each
  `Relo-Delivery-Id` once.
- Answer with any 2xx. Anything else is retried, ten attempts in all over about {{fact callback.giveUpSeconds}} (30 s, 2 min,
  10 min, 1 h, then longer gaps). A 410 stops retries at once.
- Expired or canceled questions never call back, so treat silence past the expiry as no.
- `--correlation-id` is your own reference, echoed back on every way of reading the answer.

The payload, headers and verification: [callbacks reference](/docs/reference/callbacks).

## Listen for every answer

An app behind NAT, or one that asks many questions, keeps one outgoing connection open instead:

```sh
relo listen --since "$(cat last-cursor)"
```

It prints one JSON line per answer to the questions this login asked, oldest first, each with its id,
state, option and `cursor`. Store the last cursor; after a restart, `--since CURSOR` continues without
losing or repeating an answer. `--since` also takes an ISO time, and `--once` prints what is waiting and
exits.

All four ways see the same answer; mixing them is fine. Answers from your own product over HTTP:
[Apps and webhooks](/docs/guides/apps).
