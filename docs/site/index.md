---
title: What Relo is
nav: What Relo is
summary: Every agent, script and app you run, wherever it runs, in one place on your iPhone or your Mac.
---

## Why

Your work no longer happens on one machine or in one tool. Claude Code runs on the laptop, Codex on
another computer, a custom agent on a home server. A nightly backup, a CI pipeline and a deploy script
run with nobody watching. Your own app wants a person to approve a sign-up or a refund. Each one has
its own terminal, its own way of saying it is done and its own way of getting stuck waiting for you.

Relo brings all of it into one place: your iPhone or your Mac. You see what is moving, what finished or failed,
and what needs you now, without watching a dozen screens. As you hand more work to agents and
automations, you keep it in view and nothing risky happens without your yes.

## Three kinds of source

| Source | Examples | What it sends |
| --- | --- | --- |
| **Agents** | Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI, OpenCode, Amp, your own harness | the live status of a session's work, questions before risky steps |
| **Scripts and jobs** | processing scripts, cron jobs, CI pipelines, deploy tools | the progress of a run, its outcome, a go or no-go before a step |
| **Apps and services** | your own product, an auth system, internal tools | a human in the loop: approve a request over the HTTP API, with a signed callback |

Agents and scripts talk to Relo through the `relo` CLI on their computer. Apps and services call the
HTTP API. They all land in the same place, in the same lists.

## What you get

1. **Status.** The work in progress and how far along it is, live on the iPhone Lock Screen and in
   the Dynamic Island, or in your Mac's notch. A card shows the goal, the current step and the plan, and stays only while it is
   relevant.
2. **Time-sensitive alerts.** A question that needs you breaks through. Progress updates stay
   silent, and the outcome, finished or failed, arrives once, so a buzz means something.
3. **Details.** A plan with named steps, a status in real words, a link to the report, opened when you
   want them.
4. **Input.** Approve, decline, answer yes or no or pick an option, from the Lock Screen, a
   notification, the app or the Mac's notch. The source waits for your answer and carries on. No answer means no.

## Private by design

Agents work on client code, unreleased plans and personal matters, so what they tell you must stay
yours. Relo for Mac on its own runs on that one Mac, and nothing leaves it. With your own server
and an iPhone, the `relo` CLI encrypts every card, question and notification on the computer that
sends it, and only your own devices can open it. The server is one you run, and even it cannot read
the content or forge your answers. It can delete content after a few hours, and the phone replaces its
keys every 10 hours, so an old copy can never be opened again. Read [Privacy and security](/docs/privacy).

## Where to go next

<ul class="docs-tiles">
<li><a href="/docs/get-started"><strong>Get started</strong>Download Relo for Mac, or run your own server, connect a computer, optionally add your iPhone, and see your first card.</a></li>
<li><a href="/docs/concepts"><strong>Concepts</strong>Work, cards, questions, notifications, sessions and how Relo decides what to show.</a></li>
<li><a href="/docs/guides"><strong>Guides</strong>Agents, hooks, scripts and CI, apps over HTTP, and running your server well.</a></li>
<li><a href="/docs/reference"><strong>Reference</strong>Every command, exit code, environment variable and HTTP operation.</a></li>
</ul>

New here? [How Relo works](/docs/how-it-works) shows the path from a producer to your iPhone or Mac in
one picture.
