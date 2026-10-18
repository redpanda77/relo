# ADR 0012: The working layer: rounds, plan trees, continuity and efficiency

Status: accepted, 16 October 2026; implemented in phases. Amends the lifecycle parts of
[ADR 0007](0007-presence-messages-work-separation.md) and [ADR 0008](0008-relo-design-framework.md);
applies [ADR 0009](0009-cli-structure.md) (setup as one plan) and [ADR 0010](0010-shared-server-modules.md)
(facts, card actor). Changes the hooks values of [ADR 0011](0011-computers.md)'s remote settings allowlist.

## Context

ADR 0007 and 0008 say a work survives turns and its plan grows in place ("bridge and extend, never force a
restart"). In practice every request opened a new card, plans stayed flat lists, and a card could stay open
by accident:

- `finish` meant both "I delivered this request" and "the goal is over". It was the only way to notify the
  owner of a result, finished work was terminal, the CLI dropped it from the session, and the Stop reminders
  said "finish" whenever a plan's steps were done. So each request ended in a finish and the next began a
  new work.
- Plans were flat by decision (a phase was a step; two-level phases were left out).
- Hooks acted only at Stop and on restore. Nothing reached the agent when a new request arrived, which is
  where it decides to continue or start over; static instructions fade over a long session.
- A refused `finish` (outcome over the cap) left no trace; reminders keyed on freshness alone missed it.
- Instructions taught card mechanics only: nothing on planning depth, relevance of an open plan, context,
  handoff, or subagent cost. Subagents ran on the main model because nothing set otherwise.

Research: hook-injected state at prompt time beats static rules; plans in good systems grow by
linking and never delete steps; depth is earned (two to four levels); a readable handoff beats compaction;
subagent cost is a default; capabilities differ by environment.

## Decision

1. **Relo has two roles.** The notification system (always) and the **working layer** (opt-in): Relo is the
   agent's durable plan and progress record across turns, compaction, resume and handoff, and nudges
   efficient work. It never takes control: agents keep full autonomy, the owner chooses the depth.

2. **A work has rounds.** One goal is one work for its whole life. Each request that continues the goal is a
   **round**: a title in the owner's words, its steps, and an outcome. Every work has at least one round;
   round 1 is opened by `start` and titled by the goal unless named.
   - **Closing a round** (`relo work deliver --outcome "…"`) notifies the owner with the outcome, ends the
     Live Activity as a finish does, and keeps the work open. Derived as "your turn".
   - **Opening the next round**: `start` on an open work whose last round is closed opens a new round
     (`--round "…"`, required then; `--plan` sets its steps). A `start` on an open round continues as today.
   - **`finish`** ends the goal (done, failed, dropped) and closes the open round with the same outcome. It
     stays terminal. A work whose last round is closed and that sees no new round retires to History by
     derivation; that is never stored as a finish.

3. **The plan is one tree.** Rounds are its top-level nodes; steps nest up to three levels below a round
   (four in all). Nodes keep flat, never-reused ids (`s1…`, rounds `r1…`) with a `parent`; display numbers
   (`2.1.3`) are computed. Any step may carry a `detail` line (up to 200 characters). Steps are never deleted:
   done, skipped or superseded. Work discovered mid-task joins the tree (`--under <id>`), never a new card.
   Depth is earned: flat stays valid and is the default. Caps: 30 steps per round, 120 nodes per work.

4. **The decision point is the new request.** With hooks at Guide level, UserPromptSubmit injects the open
   work's state (goal, last round and whether it is closed, current step) and the three moves: continue
   (new round), new goal (`start --new`), done (`finish`). Without hooks, a `start` echo says the same.
   Restore after compaction, resume and `/clear` injects the plan and one line per earlier round.

5. **Handoff keeps one card.** `relo work handoff --next "…"` keeps the round open (amended 16 October:
   closing it would tell the owner "your turn" mid-request), sets the status to the handoff note and prints
   a single-use handle (24 hours); the next session in the same project is offered it by the hooks. A new session on the same account and computer runs
   `relo work start --from <handle>` and becomes the work's session. This is the only way a session takes
   over another's work: the owning session grants it, the server checks account and computer, and the old
   session loses it. Relo suggests a fresh session (handoff, then `/clear` or a new session); it never
   starts one itself. Agents may use their environment's own session tools.

6. **A card never stays open by accident.** The CLI records a refused lifecycle command (finish, deliver,
   handoff) in the session file. The Stop reminder chases a pending refusal first, regardless of freshness,
   and reminds whenever an open round ends a turn in an unknown state (not delivered, not waiting on
   something named, steps left). Refusals give a specific fix (for a long outcome, the agent's own
   text cut to fit). The guard refuses a `relo` command whose reply the agent would not read (sent to
   `/dev/null` or piped), the one decision a guard makes, and never on a card; without hooks the CLI sends
   an agent's reply to stderr when stdout is `/dev/null`. Before an edit the guard adds one line when the
   card cannot be right: no card, a delivered round with new work under way, or one step held 10 minutes.
   Every prompt says whether the session has a card and, if not, how to start one by plan shape. With presence
   hooks the server derives **left open** (turn ended, idle 5 minutes, round open, not waiting): dimmed on
   the Lock Screen, folded elsewhere. The owner can end a hanging or left-open work from the phone.
   Display only; declared state is never changed by derivation.

7. **Context and cost are observed facts.** At Optimize level Relo wraps (never replaces) the owner's status
   line to read context use and session cost; they ride the session's phase snapshot (observed source).
   Above a threshold (default 60% of the window) the next prompt-time injection suggests a handoff, once per
   round. The card shows context and cost only if the owner opts in.

8. **Efficiency guidance is opt-in and never overrides.** The efficiency module teaches: name a model on every
   subagent call (small for search, mid for implementation, large for planning and review), start fresh
   subagents not forks, keep coupled or small work in the main session. The guard nudges an Agent call
   without a model. Named agent definitions install at the lowest-priority scope; environment defaults only
   with explicit consent; never a force flag. Compaction instructions name what to keep.

9. **Setup has four depths**, each including the ones above: **Notify** (ask and notify, no cards),
   **Track** (cards, rounds, plan trees; the default), **Guide** (presence hooks: prompt-time decision,
   restore, round and refusal reminders, left open), **Optimize** (efficiency module and its optional
   installs, each asked). Approvals (permission prompts on the phone) stay a separate switch at Guide and
   above. The CLAUDE.md block is one marked region of modules (notify, or reporting, planning, continuity,
   efficiency) whose start marker names them, so the installed files are the depth's only record; the skill
   holds the details. The hook sets are `off`, `presence` and `approvals` (`reminders` is gone), and
   `--hooks` is replaced by `--level` (dev mode, no aliases). Plan 12 §4.7 has the experience.

## Ownership (unchanged rule, new fields)

| Field | Source |
|---|---|
| rounds (title, outcome, closed), plan tree, detail, handoff note | declared, by the owning session |
| context use, session cost | observed, by the session's hooks |
| your turn, left open, retirement | derived, by `derive()` |
| pending refusal | local CLI state, never sent |

## What code review rejects

- A request that ends a turn by finishing a work whose goal continues (in instructions, reminders or echoes).
- A step removed from a plan, or a plan node without a parent chain to a round.
- Nesting deeper than three levels below a round.
- A session taking over another session's work by any path other than a handoff handle.
- A hook or derivation writing rounds, plan, outcome or lifecycle.
- Relo starting a session, setting a force flag, or replacing the owner's status line.
- Context or cost stored as declared state.

## Consequences

One card follows a goal across requests, handoffs and compaction; the owner sees rounds with their outcomes
and a tree that grows. Instructions shrink to modules and hooks carry timely state. Contracts change the
plan shape (v2), so the iOS decoder, the Dashboard, sealed plan entries and the docs change with it. The
ADR 0011 remote setting `hooks.<harness>` becomes `level.<harness>` with the four depths.
