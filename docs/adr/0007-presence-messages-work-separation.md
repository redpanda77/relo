# ADR 0007: Presence, messages and work are separate, and work continues by the session

Status: accepted, 14 October 2026, and implemented. Refined by [ADR 0008](0008-relo-design-framework.md)
(the design framework, including the edge split between the CLI and the server). The rules below
describe what the code does; the derivation constants and the owner-facing terms are in
[ARCHITECTURE.md](../ARCHITECTURE.md#state-model).

## Context

Relo shows three different things on the owner's iPhone, and until this decision they shared one identity:

- **Presence**: whether an agent session is working, waiting for the owner, idle or gone. It comes
  from optional hooks (Claude Code, Gemini) and is approximate by nature.
- **Messages**: one-shot notices (`relo notify`) and questions (`relo ask`).
- **Work**: a goal the agent is pursuing, with a plan of steps, shown as a Live Activity card.

They were joined by one string, the card key derived from the session id. Audits on 14 October 2026
found what that coupling causes:

- Presence ended work. Session end, session loss and the idle reconciler ended cards; an ended
  session row ended every new card with the same key for days; a long tool call read as "lost" and
  its card ended.
- Work did not continue. A second `activity start` silently overwrote a running card's title, topic
  and whole plan; an ended card made the next phase a new card; a new topic made a new thread.
- Subagents share the parent's session id, so their commands rewrote or ended the parent's card.
- Step labels lived only in a CLI-local cache, so placeholders ("Step 1…") were sealed back.
- Without hooks, only time ended anything, and two agents with the same topic shared one card.

Research (documented patterns): presence is a lease that may flag domain state but never owns it
(Kubernetes Lease, Consul sessions, Ably and Phoenix presence); long-running work is addressed by a
server-assigned handle with a separate client key (GitHub check runs, Google AIP-151) and one open
run per business id (Temporal); writes use idempotency keys (Stripe) and versions (AIP-154); state is
output-only and changes through verbs (AIP-216); tools for agents are poka-yoke: explicit verbs, no
ids the tool already knows, errors that name the next command.

## Decision

### Three entities, three owners, no shared key

| Entity | Identity | Written by | Ends by |
|---|---|---|---|
| **Session** (presence) | harness and session key | optional hooks, as phase snapshots; the session's own `relo` calls update last seen | `ended` from its harness, or derived "ended" after silence; never ends work |
| **Message**: notice, question | server id and client idempotency key | `relo notify`, `relo ask` | delivered, answered, expired or canceled |
| **Work**: a goal with a plan | server `work_id` (`wrk_…`), bound to one session (agents) or one producer key (scripts) | the producer that holds it | its own `finish` (finished, failed, dropped) |
| **Card**: one Live Activity | `act_…`, belongs to one work | the server, as a projection of the work | when its work ends or retires from the screen |

Rules enforced in code, each with a test that fails if the coupling returns
(`apps/server/src/work-model-invariants.test.ts`, the CLI hook invariant tests):

1. **Hooks write observed session state only.** No hook event, session end, session loss or idle
   state creates, updates or ends work, cards or messages.
2. **Work has its own lifecycle.** `open`, `paused`, `finished`, `failed`, `dropped`. Only the
   producer moves it, by verbs. Time never writes it: a work nobody touches is shown dimmed, then
   folded, then listed as "left unfinished" by the derivation, and its declared state stays as it was.
3. **Work continues by the session.** An agent session has at most one open work. `relo work start`
   again continues it and says so; `--new` parks the open one (still readable) and starts another.
   The CLI keeps the session's working copy and finds it from the harness's session id, so the agent
   never repeats a handle. A work survives turns, `/clear`, compaction and resumes. Start takes an
   idempotency key; a retry returns the same work.
4. **Plans are revised, never overwritten.** Steps have stable ids (`s1…`) and states `open`,
   `current`, `done`, `skipped`; the plan has a version and writes carry the version they read.
   Completed steps stay completed; a step dropped from a revised list becomes `skipped`. Step labels
   are stored on the server (sealed on an end-to-end account), so placeholders are never sealed back.
5. **Cards are views of work.** A work shows as at most one card; the card is a projection and the
   server derives whether it is shown. The app's detail screen and History show the whole work.
6. **Messages reference work, never take it over.** `relo ask` attaches to the session's open work
   and leaves its plan and lifecycle alone. Without an open work a question is a standalone message.
   An unanswered question never ends a work.
7. **Subagents never write work they don't hold.** They roll up into their session: a session
   running subagents is simply working, and their hook events only add to the parent's activity.
8. **Without hooks everything still works.** Work, cards and messages need no hooks. A session's
   freshness comes from its own writes; hooks only add observed evidence and reminders.

### No compatibility layer

Relo has one product contract. `relo activity start|update|end` are not available to agent sessions
and there are no aliases: an agent that types one is told which `relo work` verb replaces it. Scripts
and apps keep the card commands and the producer routes, which are a different producer type
([INTEGRATING.md](../INTEGRATING.md)). The skill, `CLAUDE.md` guidance and `relo help` describe
`relo work` for agents.

## Consequences

- One goal is one work for its whole life; phases, plan changes and topic changes no longer create cards.
- Presence is honest and harmless: a wrong or missing hook can mislabel a session but can no longer
  end anyone's work.
- Agents have less to remember: start once, then update, pause, resume and finish; the CLI knows the session.
- More server state: works, plan steps and the producer's own sealed copy; cards reference works.
