---
title: relo notify
summary: Every option of the one-shot message about a finished outcome.
---

`relo notify` sends one notification. Use it sparingly: a work's finish outcome already is the
notification, so `relo notify` is for a result that has no open work, such as a backup that ran
without a card. It never asks: a question is `relo ask`. `relo notify withdraw` removes a delivered
notification from the phone. When notifications alert and when they stay quiet:
[Notifications](/docs/concepts/notifications).

```sh
relo notify "Nightly backup finished: 42 GB in 18 minutes" --title "nightly-backup"
```

## Commands

{{cli notify}}
