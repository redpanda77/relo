---
title: relo work and relo state
nav: work and state
summary: Every command and option that declares a goal, a plan, a status and an outcome, and reads them back.
---

A work is one goal with an optional plan, a status line and, at the end, an outcome. It is the card
on your Lock Screen and the line in Now. Agents run these commands inside their session; scripts and
apps run the same commands with `--producer KEY`, which names the job so later commands find the same
work. Why works look the way they do: [Work](/docs/concepts/work).

Each command prints its echo: the plan, what you see on the phone and the next command to run. `relo
state` reads back what the session (or the producer key) has open and parked, from the local copy.
Options marked with a "For" column apply only to that kind of caller.

```sh
relo work start --goal "Import yesterday's orders" --plan "Download,Validate,Load"
relo work update --status "Validating 4,200 rows" --next-step
relo work finish --outcome "4,200 orders imported"
```

## Commands

{{cli work}}
