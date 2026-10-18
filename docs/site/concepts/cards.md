---
title: Cards and what you see
nav: Cards
summary: One card per work on your Lock Screen, shown only while it is fresh and relevant, in real words, and folded away when it is not.
---

A card is how a work reaches you. It answers your questions in order: does anything need me, did
something finish or fail, is it moving, and what happened while I was away. Your server decides
what each card shows and when, so every surface tells the same story.

## Where cards appear

- **Lock Screen and Dynamic Island.** The live card: the goal, the current step, a count, and the
  answer buttons when the work asks you something. It also appears in StandBy and in the Apple
  Watch Smart Stack. At most three Relo cards show at once, the most relevant first.
- **Now.** The Relo app's first screen, in sections: Needs you, Since you looked, Waiting on you,
  Running, Quiet and Paused.
- **History.** Every work, finished or not, with its plan and outcome.
- **Dashboard.** The same Now and History in a browser on a computer.

## A card worth a glance

Relo keeps three promises about every card.

### Fresh

A card shows current state or it steps back. The clock is the producer's last write (and, with
[hooks](/docs/guides/hooks), the last sign of life from its session).

| Time without a write | What happens |
| --- | --- |
| under 20 minutes | the card shows as moving |
| 20 minutes | the card is dimmed on the Lock Screen and folded under Quiet in Now; never shown as running |
| 60 minutes | the card leaves the Lock Screen |
| 8 hours | the work counts as left unfinished: shown once under Since you looked, then in History |

Any update brings the card back. A work that says it is waiting (`--waiting "CI"`) stays undimmed
for up to an hour. A script can renew a lease with `relo work heartbeat` to say it is still alive.

### Visible only while relevant

A card is on your Lock Screen while it needs you, is waiting on you, is moving, or has just finished:

- **Needs you**: a question is open. The card goes to the top and alerts.
- **Done**: the final card stays {{fact card.doneSeconds}}, then leaves.
- **Failed**: the final card stays {{fact card.failedSeconds}}.
- **Paused** or **dropped**: off the Lock Screen at once. Paused waits in Now; dropped is in History only.

### Informative

The card carries real words: the goal, the step being worked on, a measured count. Placeholders,
paths and secrets are refused before they are sent (see [work](/docs/concepts/work#real-words-only)).

## Never show trash

Agents crash, scripts die, sessions are closed mid-turn. Relo does not let that clutter your
screens: what runs is shown, and what does not is not. A work that went silent is dimmed, then
folded under Quiet, then moved to History. These safeguards change only what is shown. They never
change or end the work itself, so a producer that comes back picks up where it was.

Without hooks the safeguards rely on the producer's own writes, which is why the timings above are
the same for everyone. With hooks, Relo can also tell a session that is working quietly from one
that stopped responding, and show "your turn" when an agent's turn ended and it is waiting for you.

## What alerts and what stays silent

| Event | On your phone |
| --- | --- |
| A work starts | the card appears, with one alert the first time it shows on the Lock Screen |
| An update, a new step, a count | silent: the card changes in place |
| A question on the work | time-sensitive alert; breaks through Focus |
| Finished | one quiet notification with the outcome |
| Failed | an alert with the outcome |
| Dropped, paused, gone stale | silent |

So the only sounds you hear are a decision that waits on you and an outcome you should know about.
More in [notifications](/docs/concepts/notifications).

## One policy, everywhere

The Lock Screen, Dynamic Island, Watch, the app and the Dashboard display what the server derived.
None of them keeps timers or rules of its own, so a card cannot be "running" on one screen and
stale on another. The rules are explained in [the three sources of state](/docs/concepts/state).
