# Planning a work: a worked example

Read this before tracking long, multi-phase, or exploratory work. [cli.md](cli.md) has the exact
flags; [security.md](security.md) covers what may appear in work text.

## Contents

- [What the work is for](#what-the-work-is-for)
- [The worked example](#the-worked-example)
- [Parallel work is one step with a count](#parallel-work-is-one-step-with-a-count)
- [Plan steps or a count](#plan-steps-or-a-count)
- [Statuses that read well on a Lock Screen](#statuses-that-read-well-on-a-lock-screen)
- [Questions on the work](#questions-on-the-work)
- [Delivering and finishing](#delivering-and-finishing)
- [Nested steps](#nested-steps)
- [What the owner sees](#what-the-owner-sees)

## What the work is for

The work answers one question for the owner at a glance: *what is the agent doing right now, and
does it need me?* It replaces a stream of notifications. One open work per session: start it once,
update it between milestones, finish it once. A repeat start continues the open work and says so;
another goal is `relo work start --new` (the old one is parked). Asking attaches to the open work and
never starts one. Subagents run no relo commands.

Skip the work only for something that finishes in under a minute or two with nothing to report.

## The worked example

Every command prints an echo: the work, its plan, `Owner sees: …` and `Next: …` with the exact
command. Read it; it is the state. A planless start:

```bash
relo work start --goal "Fix the login crash" --status "Looking into the crash report"
```

```
Work wrk_8f2c1a9e "Fix the login crash" (open, started)
  Status: Looking into the crash report
Owner sees: on the Lock Screen, "Looking into the crash report"
Next: relo work update --plan "…"  |  relo work finish --outcome "…"
```

Unsure how the work goes? Plan how you will find out, then grow the plan as you learn:

```bash
relo work update --plan "Reproduce the crash,Find the cause,Choose the fix"
relo work update --status "Reproduced on iOS 17" --next-step
relo work update --next-step
relo work update --add "Patch token refresh,Run tests,Ship"
relo work update --next-step --plan "Patch token refresh,Add regression test,Run tests,Ship"
```

The last line finishes "Choose the fix" first (`--next-step` runs before `--plan`), then lists what
is left; done steps stay done and a new step lands after the current one. An update that revises the
plan prints the header `(open, updated)` and reports every move as a note:

```
Note: skipped s4 Run all gates (left out of --plan)
Note: s3 Choose the fix skipped (left out of --plan; add --next-step to mark it done)
```

A repeat start with a different goal changes nothing:

```
Work wrk_8f2c1a9e "Ship the 0.17 release" (open, continuing)
  [x] s1 Bump versions
  [>] s2 Run local gates   (3/5)
  [ ] s3 Tag and publish
Note: open work is "Ship the 0.17 release". You passed "Release 0.17". Nothing changed.
Note: same goal → relo work update --goal "Release 0.17"; new goal → relo work start --new --goal "Release 0.17"
Owner sees: on the Lock Screen, "Step 2 of 5 · Run local gates · 3 of 5"
Next: relo work update --progress 4/5  |  relo work update --next-step
```

A different goal really is new (`relo work start --new --goal "Fix the flaky upload test"`):

```
Work wrk_5d0e7b21 "Fix the flaky upload test" (open, started)
  [>] s1 Reproduce the failure
  [ ] s2 Find the cause
Note: parked wrk_8f2c1a9e "Ship the 0.17 release"; its card left the Lock Screen.
Owner sees: on the Lock Screen, "Step 1 of 2 · Reproduce the failure"
Parked: wrk_8f2c1a9e "Ship the 0.17 release" (paused 10:44) → relo work resume wrk_8f2c1a9e  |  relo work finish --work wrk_8f2c1a9e --outcome "…"
Next: relo work update --next-step  |  relo work finish --outcome "…"
```

Away for a while: `relo work pause --status "Waiting for the owner's design review"` prints the
header `(paused, paused)`, `Owner sees: nothing on the Lock Screen; Now › Paused` and
`Next: relo work resume  |  relo work finish --outcome "…"`. `relo work resume` prints
`(open, resumed)`, plus `Note: parked wrk_… "<goal>"` when another work was open.

Finishing, `relo work finish --outcome "0.17 built and tested; publishing moved to tomorrow"`:

```
Work wrk_8f2c1a9e "Ship the 0.17 release" (finished, done)
  [x] s1 Bump versions
  [x] s2 Run local gates
  [-] s3 Tag and publish   (skipped)
  Outcome: 0.17 built and tested; publishing moved to tomorrow
Owner sees: the final card for 15 min and one notification: "0.17 built and tested; publishing moved to tomorrow"
Next: nothing open in this session. A new goal: relo work start --goal "…"
```

## Parallel work is one step with a count

Steps are milestones in order. Parallel work (subagents, several jobs) is one step with a count:
`--progress 2/6`. There is never more than one current step: the Lock Screen shows one "now" line.
Collapse the parallel part into one step and count it:

```bash
relo work update --plan "Write six plan sections,Review the plan" --progress 0/6
relo work update --progress 2/6
```

The card reads "Write six plan sections · 2 of 6". The count belongs to the current step and clears
when the step changes (`--next-step`). Only what is left is retyped, never the done history.

## Plan steps or a count

Progress is measured or absent.

- **Judgment work** (refactor a module, investigate a bug, ship a release): a plan of named
  milestones the owner would recognize, advanced with `--next-step`. Name steps concretely ("Run
  migrations", "Install on iPhone"): "Step 2", "Phase 1", "todo", "done", "in progress", paths and
  secrets are refused before anything is sent, and so is a step the owner performs: what the owner
  must do is a question or a note.
- **A known count** (generate 10 images, polish 20 chapters, migrate 400 rows): a work without a
  plan and `--progress 3/20`, updated as each unit finishes. On a planned work the count attaches to
  the current step instead.
- **Neither** fits (exploratory, no known total): start a plan of how you will find out, or let the
  status carry the phase.
- Never estimate from elapsed time, tool calls or confidence. A percentage (`40%`) or a fraction
  (`0.4`) is refused: a 12-minute image batch is `--progress 7/10`.

## Statuses that read well on a Lock Screen

Good: "Running tests", "Reproduced on iOS 17", "Reviewing 3 changes".
Avoid: step narration ("Calling the read tool"), raw commands, paths, or anything from
[security.md](security.md)'s never-send list. Waiting on something outside (CI, a review, a
background job such as a deploy) is `--waiting "CI"`, cleared with `--not-waiting`: the card is not
dimmed while it waits, and a turn that ends under it stays moving instead of "waiting on you" (up to an hour).

Update on real milestones only. A work's first appearance on the Lock Screen alerts once, updates are silent, questions alert again, and the
deliver or finish outcome is the one notification.

## Questions on the work

`relo ask` puts the question on this session's open work (details in [cli.md](cli.md#questions)):

- One question at a time; wait for the answer before asking another.
- The question is the decision in one line of at most 120 characters, self-contained: the owner may
  answer from the Lock Screen without context. A longer one is refused.
- Everything else goes in `--detail`: why you ask, the risk, what changes, how to undo it.
- Tappable answers only: approve/deny, yes/no, or 2-4 options (`--option LABEL`). A picked option is a
  preference, never permission: anything risky still needs an `--approval` question answered `approved`.
- In a session `ask` waits about <!--f:question.agentWaitSeconds short-->100s<!--/f-->. Exit `4`: still open, run `relo interaction wait ID`. Exit `8`:
  closed without an answer, do not act. An answer that shows up later in an echo
  (`Answer since you asked: … (late: not permission)`) is never permission: ask again.

## Delivering and finishing

One goal is one work, and each request on it is a **round**. `relo work deliver --outcome "…"` ends
the request you just did: the round closes, the owner gets the outcome as one quiet notification, it is
their turn, and the work stays open:

```
Work wrk_8f2c1a9e "Ship the 0.17 release" (open, delivered)
  [✓] Round 1 "Ship the 0.17 release": 0.17 is on TestFlight
Owner sees: the round's final card and one quiet notification: "0.17 is on TestFlight"; then it's the owner's turn
Next: the round is delivered. A follow-up on this goal: relo work start --round "<the request in a few words>" --plan "…"  |  goal done: relo work finish --outcome "…"
```

Their follow-up on the same goal is `relo work start --round "Add the release notes" --plan "Draft them,Review them"`
(round 2, header `(open, round_opened)`); without `--round` the start is refused and the refusal names it.
Without `--plan` the round carries the unfinished steps of the one before; a `--plan` replaces them (the echo says how many were not carried).
A different goal is `start --new`. Deliver when a request is done; do not finish a goal that continues. `deliver` is
refused while top-level steps are open (exit 2, naming them): the owner must act mid-plan is `relo ask … --approval` or
`--waiting`; this request is done with steps left is `deliver --drop-rest` (skips them; the next round carries them).

Finish exactly once, when the goal itself is done, with `--outcome` (what happened, in the owner's
words), plus `--failed` or `--dropped` when it did not succeed. Open steps become skipped. A finished
work is never reopened. The outcome is the notification: no separate `relo notify` is needed (a
notify while a work is open is recorded on it and sends no buzz). A refused deliver or finish is
remembered: `Refused earlier: …` leads every echo until one is accepted.

## Nested steps

A plan nests when a step cannot be finished in one go, never by default. In a newline-separated
`--plan`, indent a line two spaces to put it under the line above (three levels at most), or add under
a step with `--add "…" --under s3`. Only a step without sub-steps is current; `--detail "…"` explains it:

```bash
relo work update --add "Handle quoted fields" --under s3 --detail "Quotes inside quoted fields break the split"
```

```
  [x] s1 Read the spec
  [>] s2 Build it
    [>] s3 Parse the rows
      [>] s6 Handle quoted fields
        Quotes inside quoted fields break the split
    [ ] s4 Write the rows
  [ ] s5 Verify it
Owner sees: on the Lock Screen, "Step 2 of 5 · Parse the rows › Handle quoted fields"
```

## What the owner sees

Every echo has an `Owner sees:` line computed by the server, so you learn what your writes cause:
moving work shows "Step 2 of 5 · <current step>" on the Lock Screen; no update for 20 min dims
the card; 60 min without one takes it off the Lock Screen (any update brings it back); a paused work
shows only in Now › Paused; a done work shows its final card for 15 min with one quiet notification;
a failed one for 60 min with an alert; a dropped one goes to History only.

Relo for Mac also says updates aloud on the owner's Mac, after their sound, always in one frame:
"<Kind>: <name>. <gist>". Kind is `Needs you`, `Failed`, `Your turn` or `Finished`, so the owner knows from
the first words whether it needs them ("Finished: Notch redesign. The cards are uniform and the list scrolls.").
The lengths follow published guidance on spoken messages (ADR 0015): an urgent line carries the fewest ideas, news
may carry up to about seven.

- **Name**: give the work a spoken name on start, `--spoken-name "Notch redesign"`: a noun phrase of 2 to 4 words
  (`relo work update --spoken-name` changes it). Without one the Mac takes the goal's first words, and the start
  echo says which.
- **Gist**: on `deliver` and `finish`, write the line for the ear with `--say "…"`: what happened and what it means,
  at most 20 words; for a failure, the reason in at most 12. Never only "done": say what is done. No versions,
  build numbers, hashes, ids, paths or links (they are refused); a count that is the news ("3 suites failed") is
  fine. Without `--say` the CLI cuts the outcome's first phrases and the echo asks you to write it next time;
  `Mac says: "…"` shows the whole line either way.
- **Questions**: put the decision in the first sentence, at most 12 words, and the reasons after it or in
  `--detail`; only the first sentence is said.
- **Voice level**: the start echo says how much is said here. `relo voice` sets it for this computer, `relo voice
  LEVEL --here` for one project, `RELO_VOICE` for one shell: `off` (nothing; a confidential project), `brief` (the
  kind and the name), `full` (and the gist) or `verbose` (and each finished step, the default). At verbose, name
  steps for the ear too. The owner's Mac setting can lower it, never raise it.

The name and `--say` travel only inside the end-to-end encrypted card (a readable work says they were not sent and
the Mac says the frame alone).
