---
title: Notifications
summary: Your phone buzzes rarely and on purpose, for a decision that waits on you or an outcome you should know about.
---

Agents, scripts and apps produce a lot of activity. If each step buzzed, you would mute Relo within
a day and miss the one thing that mattered. So progress lives on the card, silently, and only two
kinds of event reach you as a notification: something that needs you now, and something that ended.

## The finish outcome is the notification

When a work finishes, its outcome is the message: "Login fixed: token refresh patched and tested".
You get it once, with no extra command:

- **Finished**: one quiet notification. It lands in Notification Center without lighting up the
  phone or breaking through Focus.
- **Failed**: an alert, because a failure usually means you have something to do.
- **Dropped**: no notification. The work is in History.

The outcome also stays under Since you looked in Now until you open it, so nothing that finished
while you were away is lost.

## Time-sensitive: what needs you

A [question](/docs/concepts/questions) is the only time-sensitive event. It breaks through Focus,
lights the screen and expands the Dynamic Island once, because the producer is waiting and the
question may expire. A new phone or computer asking for access to your encrypted content also
notifies you, so it never goes unnoticed.

## `relo notify`: only when no work is open

`relo notify` sends a one-shot message about a finished outcome, for producers that have nothing
to track: a cron job that ran in seconds, a backup that completed, a check that failed.

```sh
relo notify "Nightly backup finished: 42 GB in 6 minutes" --title "nightly-backup"
```

Inside an agent session with an open work, a notify is recorded on that work and sends no buzz of
its own: the finish outcome will say it. That keeps an agent from narrating its progress in
notifications.

A notification is never a question (use `relo ask`) and never progress (use `relo work update`). A
delivered one can be removed from the phone with `relo notify withdraw`.

## Quiet by design

| What happens | Sound |
| --- | --- |
| A question is asked | time-sensitive alert |
| A work fails | alert |
| A work finishes | quiet notification |
| `relo notify` with no work open | ordinary notification |
| A work starts | the card appears on the Lock Screen |
| Updates, steps, counts, waiting, pausing | silent: the card changes in place |
| A card goes stale or leaves the Lock Screen | silent |

Silence carries meaning too. A card that is not on your Lock Screen is not running; one that is
dimmed has not reported for {{fact card.freshSeconds}}. See [cards](/docs/concepts/cards).

## Private on the way

The text of a notification is sealed on the computer that sent it. Apple's push service and your
server carry a placeholder and an envelope only your phone opens, and the phone fills in the real
words before the notification is shown. See [end-to-end encryption](/docs/concepts/encryption).

Next: [the notify command](/docs/reference/cli/notify), [scripts and CI](/docs/guides/scripts).
