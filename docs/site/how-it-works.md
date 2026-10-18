---
title: How Relo works
nav: How it works
summary: Your agents, scripts and apps send small, sealed changes to a server you run, which puts them on your iPhone.
---

## The path in one picture

Every source, wherever it runs, takes the same path to your phone:

```text
 Agents          Scripts and jobs        Apps and services
 (Claude Code,   (cron, CI, deploy)      (your product)
  Codex, …)
     │                  │                       │
     ▼                  ▼                       │
 ┌──────────── relo CLI, on each computer ──┐   │  HTTP API
 │ keeps the work · seals · queues · sends  │   │
 └──────────────────┬───────────────────────┘   │
                    ▼                           ▼
        ┌──── your Relo server ─────────────────────┐
        │ clock · aggregation · delivery · authority │
        └──────────┬─────────────────────┬──────────┘
                   ▼                     ▼
        iPhone and Apple Watch       Dashboard
        Lock Screen, Dynamic Island, (browser)
        Now, History
```

Three parts do the work: the CLI on each computer, the server you run, and the devices where you read
and answer.

## Producers

A producer is anything that tells you about work: an agent session, a script or job, an app or
service. Each one declares its own intent: a goal, a plan of steps it grows as it learns, a status in
real words, a question, and finally an outcome. Nothing else writes those fields. The server never
guesses them, and optional hooks never change them.

- **Agents** run `relo work start`, `relo work update`, `relo ask`, `relo work deliver` (a request is done; `relo work start --round` opens the next) and `relo work finish` (the goal is done). The CLI
  knows which session is calling from the harness itself, so each session sees and changes only its
  own work.
- **Scripts and jobs** use the same commands with a producer key (`--producer nightly-backup`), so a
  run can be picked up by its next invocation.
- **Apps and services** call the HTTP API with a login or a service secret, and get the answer back
  by signed callback or a stream. See [Apps over HTTP](/docs/guides/apps).

## The CLI is the edge

On each computer, the `relo` CLI does the heavy lifting so the server stays small and your content
stays private:

- **It keeps the state.** Each session's work (plan, step ids, status, pending question) lives in a
  local file. If the file is lost, the CLI rebuilds it from a copy only it can open.
- **It enforces the rules** before anything leaves: one open work per session, real words instead of
  placeholders, steps in order.
- **It seals content.** Goals, statuses, step labels, questions and notifications are encrypted for
  your phones before they are sent. Project, topic and computer names travel as opaque handles.
- **It sends only changes,** through a durable outbox. A change that cannot reach the server waits on
  the computer and goes out with the next `relo` command, only to the server it was written for.
  Offline work is queued, not lost.
- **It turns hook events into phases.** With optional hooks, the CLI runs a small state machine per
  session (working, waiting on you, idle, ended) and sends a snapshot only when the phase changes.

Every command prints the plan, what you will see on the phone and the next command to run, so an agent
always knows where it stands.

## The server

The server is yours: one Docker Compose stack with an API, a delivery worker and PostgreSQL. It does
only what needs an always-on process:

- **Clock.** It is awake when your laptop sleeps, so it decides when a card is stale, when it leaves
  the Lock Screen and when a question has expired.
- **Aggregation.** It combines every computer, session, script and service into one view: what needs
  you, what is waiting, what is running, what finished.
- **Delivery.** It pushes through Apple's push service, updates Live Activities, calls back apps and
  keeps every attempt on record.
- **Authority.** It checks every credential and scope, keeps accounts and sessions isolated and makes
  retries safe.

It stores sealed envelopes and metadata. It never holds a key that opens them. What it can and cannot
see is on [Privacy and security](/docs/privacy).

One server function turns what producers declared, what hooks observed and the time into what you
see. The phone and the Dashboard only display it. See [How Relo decides what to show](/docs/concepts/state).

## Your devices

- **Lock Screen and Dynamic Island.** A Live Activity card per relevant work: the goal, the step, the
  status and the answer buttons when a question waits. A card that stops updating is dimmed, then
  leaves.
- **Apple Watch.** The same card in the Smart Stack.
- **Now.** What needs you, what is waiting on you, what is running, your sessions and today's
  outcomes.
- **History.** Finished work and notifications, with their details.
- **Dashboard.** The same account in a browser: Now, history, phones, computers, services and
  account settings. It opens sealed content only after you link that browser from your iPhone.

## What stays on the computer

- Prompts, transcripts, tool names and tool input or output. Hooks never send them.
- The readable text of your work. It leaves only sealed for your phones.
- Reminders and memory restore after compaction. They run locally and send nothing.
- Credentials, in a config file only you can read. No command takes a token as a flag.

## Next

Ready to set it up? Start with [Get started](/docs/get-started). For the vocabulary, read
[Work](/docs/concepts/work), [Cards](/docs/concepts/cards) and [Sessions](/docs/concepts/sessions).
