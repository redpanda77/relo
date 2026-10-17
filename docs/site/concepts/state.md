---
title: The three sources of state
nav: Three sources of state
summary: What a producer says, what Relo observes and what your server concludes are kept apart, so a card never claims more than is true.
---

A card can lie in two ways: it says "Running" for an agent that crashed an hour ago, or a glitch
ends work that was still going. Relo prevents both by keeping three sources of state apart. Each
writes only its own fields, and they meet in one place: a single function on your server that
decides what you see.

## The three sources

| Source | What it sets | Written by | Never |
| --- | --- | --- | --- |
| **Declared**: a producer's intent | the goal, plan and steps, status, waiting reason, question, outcome, and its own pause, resume and finish | the producer that holds the work: an agent session through `relo`, a script by its producer key, an app or service through the HTTP API | inferred by the server, set by hooks |
| **Observed**: sessions | turn running or ended, prompt waiting, session ended, tool running since, last seen | optional [hooks](/docs/guides/hooks), as phase snapshots, and the session's own relo commands | touching a work, plan, card or question |
| **Derived**: policy | needs you, fresh or stale, where it shows (Lock Screen, Now, History), how urgently it alerts, the Sessions view | one server function, from declared and observed state and the time | stored as truth, recomputed by a client, written by a producer or a hook |

## Declared: what the producer says

Only the producer knows its goal, its plan and how it ended, so only the producer writes them.
Your server never guesses a status from silence, and never marks a work done or failed on its own.
An agent keeps full control: it can extend its plan, revise it, pause, or finish, at any time.

## Observed: what the session shows

With hooks on, the CLI on your computer turns the harness's own events into a session phase (open,
working, waiting, stopped, ended) and sends only changes. That is evidence about whether the session
is alive, not about the work. A hook can mislabel a session if it fails; it cannot change or end
anyone's work. Hooks have their own credential, which can write observed state and nothing else.

Without hooks there is no observed source, and everything still works from declared writes alone.

## Derived: what your server concludes

One function on your server takes the declared state, the observed state and the time, and returns
one owner state per work: needs you, failed, done, dropped, left unfinished, paused, waiting on you,
moving, working quietly, stopped responding, no signal, or stale. A fixed table maps each state to
the Lock Screen, Now, History and the alert level. The clock behind it uses four constants:

| Constant | Value | What it governs |
| --- | --- | --- |
| Fresh | 20 minutes | a quiet card is dimmed; "your turn" lasts this long |
| Retire | 60 minutes | a quiet card leaves the Lock Screen; a declared wait stops protecting it |
| Done | 15 minutes | a finished card lingers; an ended session is hidden |
| History | 8 hours | open work counts as left unfinished; the Since you looked window |

The phone, the Watch and the Dashboard display the result. They keep no timers of their own and
refetch when your server says the answer will next change.

## Why this keeps cards honest

- **Silence cannot lie.** A producer that stops writing is dimmed, then retired, by derivation. It
  is never shown as running, and its declared state is left untouched for when it returns.
- **Glitches cannot end work.** A session that ended, a lost connection or a failed hook changes
  only the observed evidence. Only the producer finishes its work (or you, with `relo admin`).
- **Every surface agrees.** One function, one table: the Lock Screen and the Dashboard cannot
  disagree about whether something needs you.
- **Producers see the consequence.** Every `relo work` command prints `Owner sees: …`, computed by
  the same function, so an agent learns what its writes cause.

## Each producer type keeps its own evidence

Agent sessions, scripts and services are separate kinds of producer, each with its own identity
and its own evidence of life. A session has its writes and, with hooks, its phase. A script or
service has its writes and an optional lease it renews (a script with `relo work heartbeat`): a
live lease keeps its card moving, and one that dies is retired within an hour. Hooks only ever observe agent sessions.

Related: [cards](/docs/concepts/cards), [sessions](/docs/concepts/sessions), [hooks](/docs/guides/hooks).
