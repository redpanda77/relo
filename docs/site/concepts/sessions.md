---
title: Sessions
summary: Each agent conversation owns its own work and sees nothing else, while you see every session at once.
---

You may have Claude Code open in three terminals, a Codex thread on another computer and an agent
on a home server. Relo keeps them apart, so each reports only its own work, and brings them
together for you, so you see all of them in one place.

## A session is one agent conversation

A session is one Claude Code session, one Codex thread, one MCP connection. It has a name, a place
(the project, the computer and the account it runs under) and its own work: at most one open work,
plus any it parked. "Agent" is only the label of where it came from; the session is what Relo tracks.

Scripts and apps are not sessions. A script is identified by a producer key, an app by its
credential, and each has its own one open work in the same way.

## Identified by the harness

The CLI reads the session from the harness that runs the agent: the session id Claude Code, Codex or OpenCode
puts in the agent's shell. The agent never names its session, so it cannot claim another one by
mistake or on purpose. A harness Relo does not detect sets `RELO_SESSION` to a stable id. A harness
with no session id at all (some editors) gets a handle from `relo work start` that the agent passes
to later commands.

## Subagents roll up

A session that runs subagents is simply working. Relo never reports individual subagents, and they
run no relo commands: the orchestrating agent owns the card, the plan and the questions, and
counts parallel subagents as one step with a count (see [work](/docs/concepts/work)). With hooks
on, a subagent's activity counts as its parent session's activity, and a session whose subagents
still run in the background stays working after its main agent's turn ends: it is your turn only
once the last one finishes.

## Session isolation

What a session owns is visible only to that session:

- every agent-facing read and write is scoped to the calling session;
- `relo state` shows this session's open and parked work, never another's;
- an agent cannot list, update, finish or answer another session's work;
- a caller the CLI cannot identify gets no shared session state.

Two sessions with the same goal have two works and two cards. That is intentional: they are two
conversations, and each finishes on its own.

## Your Sessions view

You see across all of them. With [hooks](/docs/guides/hooks) at the `presence` level, the
Sessions view in Relo and `relo sessions` at your terminal show each session's observed state:

| State | Meaning |
| --- | --- |
| Working | a turn is running and the session reported recently |
| Waiting on you | a permission or input prompt is up, or the turn ended and it is your turn |
| Idle | open, nothing running; folded after 10 minutes, hidden after {{fact card.maxSeconds}} |
| Ended | the conversation closed; hidden after {{fact card.doneSeconds}} |

With hooks, a session whose Claude Code or OpenCode process is gone (quit or killed) is marked ended, even
though the harness sent no end event. With the Relo MCP server connected it happens within seconds of the
process exiting.

Hooks are optional and off by default. Without them, the view shows when each session last ran a
relo command (hidden after an hour), and your cards still work fully. Hooks send only the phase and its times: never
prompts, tool names, tool input or output, or transcripts.

## Owner administration

Sometimes a session is gone but its work still hangs, or you started a test card you want gone.
`relo admin` crosses sessions the way your own terminal does:

```sh
relo admin works     # every open and paused work, with its session and last update
relo admin finish wrk_8f2c1a9e --dropped --outcome "Test card, cleaned up"
```

It ends only hanging work: paused, or quiet for {{fact card.freshSeconds}}. A work that is still moving belongs to
its session and is refused. An agent uses `relo admin` only when you ask it to, and the
cross-session views (`relo sessions`, the card lookups) are refused inside an agent session.

Next: [hooks](/docs/guides/hooks), [owner commands](/docs/reference/cli/admin),
[the three sources of state](/docs/concepts/state).
