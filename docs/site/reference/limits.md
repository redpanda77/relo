---
title: Limits
summary: How fast a login can write, how long each text can be, and how long a question can wait.
---

Limits keep your Lock Screen readable and your server healthy. Text limits are checked on the
computer before anything is sent (and in `--dry-run`); a text that is too long is refused with the
limit in the message, never cut silently. Rate limits come from the server as a `429`.

## Rates

Every write counts per minute, in its own family, so a burst in one never holds up another (a flood of card
updates cannot use up the writes a question needs):

| Family (writes a minute) | What it covers | One login | One phone | One service | One account |
| --- | --- | --- | --- | --- | --- |
| Messages | notices, questions, cards, services | {{fact requests.loginPerMinute short}} | {{fact requests.devicePerMinute short}} | {{fact requests.servicePerMinute short}} | {{fact requests.accountPerMinute short}} |
| Answers | an answer on a notice (its own bucket) | {{fact requests.loginPerMinute short}} | {{fact requests.devicePerMinute short}} | {{fact requests.servicePerMinute short}} | {{fact requests.accountPerMinute short}} |
| Work | `relo work` start, update, heartbeat, pause, finish | {{fact requests.workPerMinute short}} | | {{fact requests.servicePerMinute short}} | {{fact requests.accountWorkPerMinute short}} |
| Upkeep | phone keys and tokens, read marks, computer credentials, assets | {{fact requests.upkeepPerMinute short}} | {{fact requests.upkeepPerMinute short}} | | {{fact requests.accountUpkeepPerMinute short}} |
| Hook snapshots | per computer's hooks credential | {{fact requests.snapshotsPerMinute short}} | | | {{fact requests.accountSnapshotsPerMinute short}} |

A refused write answers `429` with a `Retry-After` header and `retryAfterSeconds` in the body; the
window resets at the start of the next minute. The CLI retries a write that carries an idempotency
key once when the wait is 10 seconds or less; any longer wait, and any wait for an answer, returns
the error with its hint. A `relo work` write that is rate-limited is not lost: the CLI queues it and sends it,
in order, once the wait named by `retryAfterSeconds` is over.

Sign-in has its own limits per client address: 10 attempts a minute for password sign-in (120 for
the whole server), 5 for sign-up (30) and 10 for starting a CLI sign-in (40). After five wrong
passwords for one email, that account's next attempt waits a second, doubling up to 15 minutes; a
browser that signed in to the account before is not held back. Every request body is capped at
1 MiB.

## Work

| Field | Limit |
| --- | --- |
| Goal | {{fact work.goalMax}} |
| Status | {{fact work.statusMax}} |
| Outcome | {{fact work.outcomeMax}} |
| Waiting reason | {{fact work.waitingMax}} |
| Step label | {{fact work.stepLabelMax}} |
| Steps in a plan | 30 (at most 20 added at once) |
| Producer key | 1-100 characters of `A-Z a-z 0-9 . _ : -` |
| Lease (scripts) | {{fact lease.minSeconds}} to {{fact lease.maxSeconds}}, default {{fact lease.defaultSeconds}} |

Text is one line of real words: placeholders ("Step 2", "todo"), absolute paths and anything that
looks like a secret are refused. A card that stops updating is dimmed after {{fact card.freshSeconds}} and leaves the
Lock Screen after 60.

## Questions

| Field | Limit |
| --- | --- |
| Question | one line, 120 characters |
| Detail | 4,000 characters of Markdown |
| Options of a choice question | 2 to 4, each one line of 24 characters |
| How long it stays open | default 5 minutes; at most the server's limit (7 days unless the admin changed it, 30 days at most) |
| Correlation id | 100 characters |
| Callback token | 16 to 512 characters |

A card lives at most 8 hours; a question that stays open longer keeps waiting in Relo after its card
ends. One question at a time per card. The admin sets the longest wait in the Dashboard under
Account → Server: [Accounts and administration](/docs/guides/accounts#limits-you-set).

## Notifications and cards

| Field | Limit |
| --- | --- |
| Title | 80 characters |
| Summary | 240 characters |
| Card detail line | 240 characters |
| Link (`--url`) and image (`--image`) | 2,048 characters |
| Open cards per computer | none, unless you set one for the computer in Connections → Computers |

## Idempotency keys

An idempotency key is 1-200 characters of `A-Z a-z 0-9 . _ : -`. A request repeated with the same key
returns the first result instead of a second card, question or notification.
