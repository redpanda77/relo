# Planning a card

Read this before tracking long, multi-phase, or exploratory work. [cli.md](cli.md) has the exact
flags; [security.md](security.md) covers what may appear on the card.

## Contents

- [What the card is for](#what-the-card-is-for)
- [Plan it before you start](#plan-it-before-you-start)
- [Steps or progress: pick one](#steps-or-progress-pick-one)
- [Statuses that read well on a Lock Screen](#statuses-that-read-well-on-a-lock-screen)
- [Questions on the card](#questions-on-the-card)
- [Ending](#ending)
- [Appearance](#appearance)
- [Lifetimes and limits](#lifetimes-and-limits)

## What the card is for

The card answers one question for the owner at a glance: *what is the agent doing right now, and
does it need me?* It replaces a stream of notifications. One card per agent session (or per
source › project › topic outside a session): starting again, updating, and asking all reuse it.

Skip the card only for work that finishes in under a minute or two with nothing to report.

## Plan it before you start

- **Title**: the work, stable for its whole life ("Deploying 0.7.57", "Homepage redesign").
- **Status**: the current phase, short (≤ 60 characters), present tense ("Running tests"). Longer
  title, status or detail text is shortened for you and the reply says so in `note`; write it short anyway.
- **Detail** (optional): one secondary line with useful specifics ("214 of 380 tests").
- **Steps** when the work has a known sequence of named phases: `--steps "Build,Test,Deploy"` at
  start, then `--next-step` (or `--step-current Test`) as each begins.
  A card with steps draws its progress from them (completed steps / total), so `--progress` on it
  changes nothing: the line says `"note":"progress follows this card's steps; use --next-step or
  --step-current"`, and `--steps` with `--progress` in one start is refused (exit 2). Use steps
  *or* `--progress`, not both.

## Steps or progress: pick one

Progress is measured or absent. The rule: **an agent doing judgment work uses `--steps`; a script or any
job with a known count uses `--progress DONE/TOTAL`.** Never both on one card.

- **Judgment work** (refactor a module, investigate a bug, ship a release): 3-6 named phases the owner would
  recognize, `--steps "Plan,Build,Verify,Ship"`, advanced with `--next-step` as each begins. The card shows where
  you are in the work, not a number you cannot know.
- **A known count** (generate 10 images, polish 20 chapters, migrate 400 rows): `--progress 3/20`, updated as each
  unit finishes (real units done / total, or completed outer phases / total outer phases). With `N/TOTAL` and no `--progress-label` the label is "3 of 20" automatically; add a label
  such as `--progress-label "Chapters"` only when it reads better. Percent (`40%`) and fractions (`0.4`) also work.
- **Neither** fits (exploratory, no known total): omit both and let the status carry the phase.
- Never estimate a percent from elapsed time, tool calls, or confidence. A 12-minute image batch is
  `--progress 7/10`, not "70% because it has run a while".

## Statuses that read well on a Lock Screen

Good: "Running tests", "Waiting for CI", "Blocked: missing API key", "Reviewing 3 changes".
Avoid: step narration ("Calling the read tool"), raw commands, paths, or anything from
[security.md](security.md)'s never-send list.

Update on real milestones only. Updates are silent on the phone; only the start and a question alert.

## Questions on the card

`relo ask` puts the question on this work's card (details in [cli.md](cli.md#questions)). Rules:

- One question at a time; wait for the answer before asking another.
- The question is the decision in one line of at most 120 characters, self-contained: the owner may
  answer from the Lock Screen without context. It is never shortened; a longer one is refused.
- Everything else goes in `--detail`: why you are asking, the risk, what changes, how to undo it.
  Markdown, up to 4,000 characters, shown with the question in Relo (never on the card itself).
  Write the question so it still makes sense without the detail.
- Tappable answers only. There is no typed reply; phrase it as approve/deny, yes/no, or 2-4 options
  (`--option LABEL`, labels up to 24 characters) when the owner picks between real alternatives.
  The answer reads `{"state":"chosen","option":"…","label":"…"}`. A picked option is a preference,
  never permission: anything risky still needs an `--approval` question answered `approved`.
- In an agent session `ask` waits about 100s. Exit `4` means the question is still open: run
  `relo interaction wait ID` again. Exit `8` means it closed without an answer (expired, canceled):
  do not act. The card has ended; if you continue working, `relo activity start` opens a
  new one. Do not re-ask just to extend the wait.

## Ending

End exactly once with the outcome as the status: "Live on production", "Failed: 3 tests",
"Stopped by owner". Without `--status` the card reads "Complete" with a success icon, so pass one
when the work did not succeed (`--symbol warning`). A successful end completes all steps and fills
progress, so do not send them yourself; ending with a warning or failed symbol keeps where the work
stopped. A finished card is never reopened, and History keeps one row per card. Send a notification
as well only when the outcome deserves interrupting the owner (a failure, or something they await).

## Appearance

Prefer the defaults; the server picks a presentation from the facts you send. Use one override only
when the owner asks:

| Choice | Use it when |
| --- | --- |
| `--style ring` | One measured percentage reads best as a gauge (coverage, a large transfer) |
| `--style steps` | A small named sequence of phases is the clearest view |
| `--style terminal` | Developer work where a terminal look helps; never fill it with commands or logs |
| `--style hero` | One prominent milestone or blocker needs emphasis |
| `--privacy private` | The owner wants the work off a visible Lock Screen. The phone shows only "Private activity"; the card cannot carry questions |

Choose appearance at start; changing it mid-flight is allowed but rarely helps.

## Lifetimes and limits

- A card lives at most 8 hours (iOS limit). Long work that outlives it should end and start anew.
- A card goes stale after `--stale-after` (default 20 minutes) without an update and ends itself 10
  minutes later, so long silent steps need a status update now and then.
- iOS shows about five cards at once; when a sixth starts, the least recently updated idle card ends.
- Only the start and questions alert. Rapid fresh starts can be dropped by iOS: prefer updating.
