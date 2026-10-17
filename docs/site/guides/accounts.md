---
title: Accounts and administration
nav: Accounts
summary: Decide who has an account on your server, approve sign-ups, cut off access, and set the server's limits.
---

One server can serve several people, each with a private account. The first account owns the
server and is its admin: it decides who joins and who keeps access, and never sees anyone else's
notifications, cards, questions or phones. Everything here is in the Dashboard under **Account →
Server**.

## The owner account

The first account created in the Dashboard (the page that says **Create the owner account**) owns
the server. Its access cannot be revoked from the Dashboard, and it is the only account that sees
the server settings below. Every login, script, service and phone belongs to exactly one account and
sees only that account.

## Who can register

| Mode | Who gets an account |
| --- | --- |
| **Closed** (default) | only people you add, with a temporary password |
| **Approval** | anyone who can reach the server can register; they sign in once you approve |
| **Open** | anyone who can reach the server can register and sign in at once |

Open is for private networks only: on a public HTTPS address it acts as Approval, and the Dashboard
refuses to choose it. The iPhone signs in through the same web page, so the mode applies there too.

## Approve a sign-up

In Approval mode each request reaches you as a notification from "Relo accounts" with **Approve**
and **Deny**, and as a card on your Lock Screen when the iPhone allows Live Activities. Answer either
one, or decide in the Dashboard's account list: the decision settles all three. A request waits up to
30 days.

## Manage an account

Each account in the list shows its email, when it joined, its sessions and its phones, and these
actions:

| Action | What happens |
| --- | --- |
| **Sign out** | every browser and iPhone session ends; the person signs in again |
| **Revoke access** | the account stops working: every session, CLI login, service and phone is refused. Its data is kept. |
| **Restore access** | a revoked account works again |
| **Delete** | the account and all of its data are removed for good |

A login refused this way gets exit 3 with `ACCOUNT_DISABLED`, so its scripts stop instead of
retrying. If someone loses both their authenticator and their backup codes, reset their password:
that also turns off their two-step sign-in, and they sign in again with the new password.

## Limits you set

| Setting | Where | What it does |
| --- | --- | --- |
| Longest a question can wait | Account → Server | the longest `--expires-in` any account may ask for: {{fact question.defaultSeconds}} to {{fact question.ceilingSeconds}}, {{fact question.serverCapSeconds}} by default. A longer one is refused with `question_wait_too_long`, which names the limit. |
| Answer callbacks to your private network | Account → Server | who may send [answer callbacks](/docs/reference/callbacks) to a private address: your account only (default), every account, or nobody |
| Most open cards | Connections → Computers | per login: at the limit a card start is refused with `card_limit_reached`, and `relo ask` falls back to a question in Needs you |

## Content retention

Relo can delete content on a schedule, so even your own server keeps no history it does not need.
Set the window in `deploy/.env`, then restart the worker:

```dotenv
RELO_CONTENT_RETENTION_HOURS=10
```

Every five minutes the worker deletes notifications, their sealed bodies, questions, answers,
delivery records and ended cards older than the window. A question still waiting for an answer, an
active card and the current item for a topic are kept until they settle. Ten hours matches the
rotation of your phone's encryption keys. Leave it empty to keep content until you delete it
yourself. Deleted notifications also leave the History your iPhone loads, so a short window means a
short History.
