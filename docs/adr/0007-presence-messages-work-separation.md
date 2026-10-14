# ADR 0007: Presence, messages and work are separate, and work continues by handle

Status: accepted, 14 October 2026.

## Context

Relo shows three different things on the owner's iPhone, and until now they shared one identity:

- **Presence**: whether an agent session is working, waiting for the owner, idle or gone. It comes
  automatically from hooks (Claude Code, Codex, Gemini) and is approximate by nature.
- **Messages**: one-shot notices (`relo notify`) and questions (`relo ask`).
- **Work**: a goal the agent is pursuing, with a plan of phases and steps, shown as a Live Activity.

They were joined by one string, the card key derived from the session id
(`packages/cli/src/identity.mjs` `cardKey`, `agent_sessions.card_key`, joined by `activity_key`).
Audits on 14 October 2026 found what that coupling causes:

- Presence ended work. Session end/lost and the idle reconciler ended cards; an ended session row
  ended every new card with the same key for up to 7 days; a long tool call (>15 min) read as "lost"
  and its card ended.
- Work did not continue. `activity start` on a running card silently overwrote its title, topic and
  whole plan; an ended card made the next phase a new card; a new topic made a new thread; nothing
  linked a card to the one it continued. In three days 8 of 9 card handoffs inside a session broke
  continuity (`activity_work_items` and `activity_relationships` were empty).
- Subagents share the parent's `CLAUDE_CODE_SESSION_ID`, so their commands rewrote or ended the
  parent's card. No environment variable tells a subagent apart (Claude Code docs).
- Step labels lived only in a CLI-local cache, so placeholders ("Step 1…") were sealed back.
- Without hooks, only time ended anything, and two agents with the same topic shared one card.

Research (cited in the 14 October audit notes): presence is a lease that may flag domain state but
never owns it (Kubernetes Lease, Consul sessions' explicit `release` behaviour, Ably/Phoenix
presence); long-running work is addressed by a server-assigned handle with a separate client key
(GitHub check runs `id`/`external_id`, Google AIP-151) and a stable business id across runs (Temporal
Workflow ID vs Run ID, one open at a time, explicit conflict policy); writes use idempotency keys
(Stripe) and versions (AIP-154); state is output-only and changes through verbs with
`FAILED_PRECONDITION` on a wrong transition (AIP-216); tools for agents are poka-yoke: explicit verbs,
no ids the tool already knows, errors that name the next command (Anthropic, OpenAI).

## Decision

### Three entities, three owners, no shared key

| Entity | Identity | Written by | Ends by |
|---|---|---|---|
| **Presence**: `agent_sessions`, child rows for subagents | `(agent, session id)`, subagent `(session id, agent_id)` | hooks and a passive heartbeat on every `relo` call | its own lease (working → idle → gone); never deleted by work |
| **Message**: notification, question | server id + client idempotency key | `relo notify`, `relo ask` | delivered / answered / expired |
| **Work**: a goal with phases and steps | server `work_id` (`wrk_…`) + optional client `work_key` | the CLI holding the work's handle | `finish` (succeeded / failed / cancelled), or `abandoned` by bounded policy |
| **Card**: one Live Activity | `act_…`, belongs to one work | the server, as a projection of the work | when its work ends, or rolled to a successor card at the 8 h limit |

Rules enforced in code, each covered by a test that fails if the coupling returns:

1. **Hooks write presence only.** No hook event, session end, session loss or idle state creates,
   updates or ends work, cards or messages. The `agent_sessions.card_key` join and the session
   reconcilers that end cards are removed.
2. **Work has its own lifecycle.** States: `active`, `waiting` (a question is pending), `succeeded`,
   `failed`, `cancelled`, `abandoned`. State is output-only and changes through verbs. An
   unattended work is marked `stale` (the card dims through `staleDate`) after its stale window and
   `abandoned` only after 8 h without a write from its holder: the only automatic transitions, and
   `abandoned` is never shown as done.
3. **Work continues by handle.** `relo work start` creates a work and returns its handle; the CLI
   stores `{work_id, session, cwd, title}` in a local state file per working directory and
   conversation, so every later command continues it without the agent repeating anything. A work
   lives across turns, `/clear`, `/compact`, resumes, phases, topic changes and new cards.
4. **Starting is explicit and never silent.** A second `work start` while this conversation has an
   active work fails with the existing handle and the commands to continue it (`work step`,
   `work plan add`) or to start a parallel one (`--parallel`). Nothing ever silently reuses or
   overwrites another work. `start` takes an idempotency key: a retry returns the same work.
5. **Plans are revised, never overwritten.** Phases and steps have stable ids; the server keeps an
   append-only plan revision log. Completed steps stay completed; a removed step becomes `skipped`.
   Real labels are stored sealed on the server per step (not only in a CLI cache), so placeholders
   are never sealed back. Writes carry the version they read; a stale version is refused.
6. **Cards are views of work.** The Lock Screen shows `phase i/N · phase name`, the current phase's
   steps and the current step. Before the 8 h Live Activity limit the server starts a successor card
   for the same work. The app's detail screen and History show the whole work: phases, steps, plan
   revisions, questions and notices that reference it.
7. **Messages reference work, never take it over.** `relo ask` attaches to the conversation's active
   work by `work_id` (it shows on that work's card) and leaves its plan and state alone except for
   `waiting`. Without an active work, a question is a standalone message: it never creates a work.
   `relo notify` is a message; it may reference a work for grouping.
8. **Subagents never write work they don't hold.** Subagents have no handle (they are told not to
   run relo, and the state file records the holder's session). A command from a different holder
   than the work's is refused with the read-only handle; `relo work adopt` transfers it explicitly.
9. **Without hooks everything still works.** Work, cards and messages need no hooks at all. Presence
   falls back to "last seen" from the heartbeat each `relo` command sends. Work ends by `finish` or
   the abandonment policy, never by a missing `SessionEnd`.

### Compatibility

`relo activity start|update|end` stay as aliases of `relo work start|update|finish` for one release
with the new semantics (no silent overwrite, continue by state file). Existing cards become works
with one card each. The skill, `CLAUDE.md` guidance and `relo help` describe only `relo work`.

## Consequences

- One goal is one work for its whole life; phases, plan changes and topic changes no longer create
  cards. The Lock Screen keeps one card per work, rolled to a successor only at the 8 h limit.
- Presence becomes honest and harmless: a wrong or missing hook can mislabel a session but can no
  longer end anyone's work.
- Agents have less to remember: start once, then step, plan and finish; the CLI knows the handle.
- More server state: works, phases, steps and plan revisions; cards reference works.
