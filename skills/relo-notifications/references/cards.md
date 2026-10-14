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
- [Finishing](#finishing)
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
command. Read it; it is the state. A planless start (E-1):

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
plan (E-4) prints the header `(open, updated)` and reports every move as a note:

```
Note: skipped s4 Run all gates (left out of --plan)
Note: s3 Choose the fix skipped (left out of --plan; add --next-step to mark it done)
```

A repeat start with a different goal changes nothing (E-2):

```
Work wrk_8f2c1a9e "Ship the 0.17 release" (open, continuing)
  [x] s1 Bump versions
  [>] s2 Run local gates   (3/5)
  [ ] s3 Tag and publish
Note: open work is "Ship the 0.17 release". You passed "Release 0.17". Nothing changed.
Note: same goal → relo work update --goal "Release 0.17"; new goal → relo work start --new --goal "Release 0.17"
Owner sees: on the Lock Screen, "Step 2 · 1 to go · Run local gates · 3 of 5"
Next: relo work update --progress 4/5  |  relo work update --next-step
```

A different goal really is new (E-3, `relo work start --new --goal "Fix the flaky upload test"`):

```
Work wrk_5d0e7b21 "Fix the flaky upload test" (open, started)
  [>] s1 Reproduce the failure
  [ ] s2 Find the cause
Note: parked wrk_8f2c1a9e "Ship the 0.17 release"; its card left the Lock Screen.
Owner sees: on the Lock Screen, "Step 1 · 1 to go · Reproduce the failure"
Parked: wrk_8f2c1a9e "Ship the 0.17 release" (paused 10:44) → relo work resume wrk_8f2c1a9e  |  relo work finish --work wrk_8f2c1a9e --outcome "…"
Next: relo work update --next-step  |  relo work finish --outcome "…"
```

Away for a while (E-5): `relo work pause --status "Waiting for the owner's design review"` prints the
header `(paused, paused)`, `Owner sees: nothing on the Lock Screen; Now › Paused` and
`Next: relo work resume  |  relo work finish --outcome "…"`. `relo work resume` (E-6) prints
`(open, resumed)`, plus `Note: parked wrk_… "<goal>"` when another work was open.

Finishing (E-7), `relo work finish --outcome "0.17 built and tested; publishing moved to tomorrow"`:

```
Work wrk_8f2c1a9e "Ship the 0.17 release" (finished, done)
  [x] s1 Bump versions
  [x] s2 Run local gates
  [-] s3 Tag and publish   (skipped)
  Outcome: 0.17 built and tested; publishing moved to tomorrow
Owner sees: the final card for 15 min and one quiet notification: "0.17 built and tested; publishing moved to tomorrow"
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
[security.md](security.md)'s never-send list. Waiting on something outside (CI, a review) is
`--waiting "CI"`, cleared with `--not-waiting`: the card is not dimmed while it waits.

Update on real milestones only. Updates are silent on the phone; only questions alert, and the
finish outcome is the one notification.

## Questions on the work

`relo ask` puts the question on this session's open work (details in [cli.md](cli.md#questions)):

- One question at a time; wait for the answer before asking another.
- The question is the decision in one line of at most 120 characters, self-contained: the owner may
  answer from the Lock Screen without context. A longer one is refused.
- Everything else goes in `--detail`: why you ask, the risk, what changes, how to undo it.
- Tappable answers only: approve/deny, yes/no, or 2-4 options (`--option LABEL`). A picked option is a
  preference, never permission: anything risky still needs an `--approval` question answered `approved`.
- In a session `ask` waits about 100s. Exit `4`: still open, run `relo interaction wait ID`. Exit `8`:
  closed without an answer, do not act. An answer that shows up later in an echo
  (`Answer since you asked: … (late: not permission)`) is never permission: ask again.

## Finishing

Finish exactly once with `--outcome` (what happened, in the owner's words), plus `--failed` or
`--dropped` when it did not succeed. Open steps become skipped. A finished work is never reopened.
The outcome is the notification: no separate `relo notify` is needed (a notify while a work is open
is recorded on it and sends no buzz).

## What the owner sees

Every echo has an `Owner sees:` line computed by the server, so you learn what your writes cause:
moving work shows "Step 2 · 1 to go · <current step>" on the Lock Screen; no update for 20 min dims
the card; 60 min without one takes it off the Lock Screen (any update brings it back); a paused work
shows only in Now › Paused; a done work shows its final card for 15 min with one quiet notification;
a failed one for 60 min with an alert; a dropped one goes to History only.
