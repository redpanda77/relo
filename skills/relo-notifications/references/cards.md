# Planning a card

Read this before tracking long, multi-phase, or exploratory work. [cli.md](cli.md) has the exact
flags; [security.md](security.md) covers what may appear on the card.

## Contents

- [What the card is for](#what-the-card-is-for)
- [Plan it before you start](#plan-it-before-you-start)
- [Progress: measured or absent](#progress-measured-or-absent)
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
- **Status**: the current phase, short (≤ 60 characters), present tense ("Running tests").
- **Detail** (optional): one secondary line with useful specifics ("214 of 380 tests").
- **Steps** when the work has a known sequence of named phases: `--step Build --step Test
  --step Deploy --step-current 2`. Steps and progress answer different questions: steps say *which
  phase*, progress says *how far through it*. Use either or both.

## Progress: measured or absent

Report completed outer phases / total outer phases, or real units done / total (files, tests,
records). Never estimate a percent from elapsed time, tool calls, or confidence. For exploratory
work with no known total, omit `--progress` and let the status carry the phase.

## Statuses that read well on a Lock Screen

Good: "Running tests", "Waiting for CI", "Blocked: missing API key", "Reviewing 3 changes".
Avoid: step narration ("Calling the read tool"), raw commands, paths, or anything from
[security.md](security.md)'s never-send list.

Update on real milestones only. Updates are silent on the phone; only the start and a question alert.

## Questions on the card

`relo ask "…" --approval` or `--yes-no` puts the question on this work's card with answer buttons,
a countdown and an alert, and waits up to 5 minutes for the answer. Answered: the card returns to
the work showing the answer ("Approved · Running tests"). Not answered within 5 minutes: the
question expires and the card ends ("No answer"). Rules:

- One question at a time per card; wait for the answer before asking another.
- Self-contained and under 240 characters: the owner may answer from the Lock Screen without context.
- Tappable answers only. There is no typed reply; phrase it as approve/deny or yes/no.
- Exit `4` means no answer within 5 minutes: treat it as no and do not act. The card has ended; if
  you continue working, `relo activity start` opens a new one. Do not re-ask just to extend the wait.
- Updates sent while a question waits succeed and appear on the card once it is answered.
- If the phone cannot show the card, the owner gets one notification saying to answer in Relo.

## Ending

End exactly once with the outcome as the status: "Live on production", "Failed: 3 tests",
"Stopped by owner". Without `--status` the card reads "Complete" with a success icon, so pass one
when the work did not succeed (`--symbol warning`). A successful end completes all steps and fills
progress, so do not send them yourself; ending with a warning or failed symbol keeps where the work
stopped. In History the owner sees one row per card (source, project, topic, outcome, steps, answer,
duration), and a session has one card. End exactly once; a finished card is never
reopened. Send a notification as well only when the outcome deserves interrupting the owner
(a failure, or something they are waiting for).

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
