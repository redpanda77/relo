---
title: Work, plans and steps
nav: Work and plans
summary: Each agent session, script or app declares one goal at a time, shows how it is getting there, and closes each request with an outcome, and finishes it once when the goal is done.
---

A work answers the question you ask when you glance at your phone: what is this doing right now,
and does it need me? It replaces a stream of messages with one live card that stays current.

## One open work per producer

A work belongs to the producer that holds it:

- an **agent session** (one Claude Code session, one Codex thread), identified by the harness;
- a **script or job**, identified by your login and a producer key (`--producer nightly-backup`);
- an **app or service**, identified by its credential over the HTTP API.

Each producer has at most one open work. Starting again with the same goal continues it and says
so, instead of creating a duplicate. A different goal is a new work: `relo work start --new` parks
the current one, and `relo work resume` brings a parked or paused work back. Two sessions never
share a work, even with the same goal.

## A goal in your words

The goal is the one thing the producer must choose well. It is what you would call the job: "Fix the
login crash", "Release 0.17", "Nightly backup". Status, plan position, freshness and placement on
your phone follow from it and from what the producer reports.

## Plans that emerge

A plan is a short list of named milestones. It is for your visibility and for the record, not a
contract the producer must follow.

When the way forward is unclear, the plan starts as an investigation: how the producer will find
out.

```sh
relo work start --goal "Fix the login crash" --plan "Reproduce the crash,Find the cause,Choose the fix"
```

Once it knows more, it grows or revises the same plan in place. `--add` appends steps; `--plan`
lists what is left, keeping the done steps done and marking steps left out as skipped. Nothing
restarts, and the history of what already happened stays.

```sh
relo work update --next-step --add "Patch token refresh,Run the tests"
```

## Rounds: one goal, many requests

One goal stays one card, even when you come back with follow-ups. Each request that continues the
goal is a **round**: a title in your words, its steps and an outcome. The first round opens with
`start`.

```sh
relo work deliver --outcome "Login crash fixed; please try it on your phone"
relo work start --round "Also cover the sign-up screen"
```

`deliver` closes the round: you get the outcome as one quiet notification and it is your turn. The
work stays open. A deliver is refused while top-level steps are still open (`--drop-rest` skips them):
the plan belongs to the goal, and an owner check in the middle of it is a question or a wait, not a
delivery. `start --round` opens the next round on the same card and carries the unfinished steps;
`--plan` sets its own steps instead. `finish` is for the goal itself: use it when it is done and nothing is left. A request that only
needed one answer ends with `deliver`, not `finish`.

## Nested plans

A plan is flat by default. When one step turns out to hold several, the producer adds steps under it
instead of starting a new card.

```sh
relo work update --add "Check the refresh token,Check the cookie" --under s3
relo work update --step s3.1 --detail "Expires after 5 minutes on iOS"
```

`--step` jumps to a step: the steps passed on the way count as done, and jumping back to redo one leaves the step left behind open. Steps nest up to {{fact work.planMaxDepth}} levels below a round. `--detail` adds one line of
explanation to a step (up to {{fact work.detailMax}} characters). A round holds up to
{{fact work.planMaxSteps}} steps and a work up to {{fact work.planMaxNodes}} nodes. Steps are never
deleted: they end done, skipped or superseded, so the record stays whole.

## Handing a work to a fresh session

When a session's context is heavy, or before `/clear`, it hands the work over:

```sh
relo work handoff --next "Run the sign-up tests, then ship"
relo work start --from HANDLE
```

`handoff` keeps the round open, prints a single-use handle (valid for 24 hours), and this session no
longer owns the work. The next session on the same account and computer runs `start --from` with it
and becomes the work's session. It is the only way one session takes over another's work. Relo
suggests a fresh session but never starts one.

## Steps are milestones in order

There is one current step at a time, because the Lock Screen has room for one "now" line. Steps are
the producer's own milestones, in the order they happen. What you have to do is never a step: it is
a [question](/docs/concepts/questions) or a note in the status.

### Parallel work is one step with a count

Six subagents writing six sections, or four jobs in parallel, are one step with a count: "Write six
plan sections · 2 of 6". The count belongs to the current step and clears when the step changes.

### Counted jobs

A job with a known total and no milestones (generate 10 images, migrate 400 rows) has no plan, only
a count: `--progress 3/10`. Progress is measured or absent. Relo refuses percentages and guesses
from elapsed time.

## Waiting and pausing

Sometimes work stops for a reason outside it:

- **Waiting on something.** CI, a review, a deploy window: `--waiting "CI"`. The card says what it
  waits for and is not dimmed as stale for up to an hour. `--not-waiting` clears it.
- **Paused.** The producer steps away: `relo work pause --status "…"`. The card leaves the Lock
  Screen and waits under Now › Paused until `relo work resume`.
- **Parked.** A new goal took over (`start --new`). A parked work is paused too, and resumes the same way.

## Finishing once, honestly

A work ends exactly once, when its goal is done, with an outcome in your words (a single request ends
with [`deliver`](#rounds-one-goal-many-requests) instead):

| Ending | Command | What you see |
| --- | --- | --- |
| Finished | `relo work finish --outcome "…"` | the final card for {{fact card.doneSeconds}} and one quiet notification |
| Failed | add `--failed` | the final card for {{fact card.failedSeconds}} and an alert |
| Dropped | add `--dropped` | nothing new: History only |

Open steps become skipped. A finished work is never reopened; the next goal is a new start. The
outcome is the notification, so a producer with an open work never needs a separate
[notification](/docs/concepts/notifications).

## Real words only

A card is worth a glance only when it says something. Relo refuses, before anything is sent,
placeholders such as "Step 2", "Phase 1" or "todo", file paths, secrets, and steps the owner
performs. Status lines read like "Running tests" or "Reproduced on iOS 17", never like "Calling the
read tool".

## Every command shows the result

Every `relo work` command prints the plan (`[x]` done, `[>]` current, `[ ]` open, `[-]` skipped),
an `Owner sees:` line computed by your server, and the next command. A refused command says what
went wrong, where things stand, and what to run instead. After a break or a compaction,
`relo state` prints the same.

Next: [the commands](/docs/reference/cli/work), [agents](/docs/guides/agents),
[scripts and CI](/docs/guides/scripts), and [what the card shows](/docs/concepts/cards).
