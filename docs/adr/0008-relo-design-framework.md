# ADR 0008: Relo design framework

Status: accepted, 14 October 2026, and implemented. Refines [ADR 0007](0007-presence-messages-work-separation.md)
(presence, messages and work are separate). The state model it produced is summarized in
[ARCHITECTURE.md](../ARCHITECTURE.md#state-model); the detailed design and build list are
maintained privately alongside this repository.

## Context

Relo puts work from many producers on one owner's iPhone. A day of breakage (cards restarting per
phase, plans rewritten, subagents taking over cards, hooks ending work, idle rows everywhere,
placeholders on screen) came from one cause: different kinds of producers and different kinds of
state shared identities, code paths and lifecycle rules. This framework is the rule set every Relo
change is checked against.

## Principles

1. **Three sources of state, kept separate.** Declared (a producer's intent), observed (facts from
   harnesses and devices), derived (one server policy: attention, freshness, visibility, urgency).
   A source writes only its own fields; they meet only in the derivation.
2. **Producers keep control and autonomy.** Agents, scripts and apps own their declared lifecycle
   (start, continue, extend or revise plans, pause, resume, finish, fail). Plans exist for the owner's
   visibility, traceability and reporting, never to force a way of working.
3. **Poka-yoke and simple.** The right action is the easy one; wrong actions are impossible by
   construction, not discouraged by prose. Every degree of freedom is weighed against the misuse it allows.
4. **Plans emerge.** A producer that is unsure shows how it will find out, then extends or revises in
   place. No placeholders: they carry no information.
5. **Card UX: fresh, visible only while relevant, informative.** The owner's questions, in order:
   does anything need me, did something finish or fail, is it moving, what happened while I was away.
6. **Continuity.** Unfinished work is findable by the session or producer that owns it; the CLI keeps
   short-lived per-session state the producer can query.
7. **Harnesses are optional and separate.** Hooks are off by default and offered at setup with their
   depth explained. When enabled they own observed session state and help the agent keep its declared
   state current (reminders, memory after compaction, waking it with an answer). They never write
   declared state. Everything works without them.
8. **Research and iterate before building.** Ground decisions in documented patterns; show designs
   of this scale to the owner before building.
9. **Never show trash.** Derived safeguards keep idle, stopped, stale or broken items off the owner's
   screens; absence means not running. Observed facts are evidence for these safeguards; without them
   the safeguards rely on declared timestamps and stay as reliable as possible.
10. **Subagents roll up into their session.** A session running subagents is simply working; Relo never
    reports individual subagents, and subagents never write their session's declared state.
11. **Isolation.** What a session or producer owns is visible only to it. Identity comes from the
    harness or credential, never from the producer's say-so. Cross-session views are the owner's.
12. **Every producer type is its own module.** Built modular by type, not as one generic abstraction
    with per-type branches; shared code only for identical primitives; cooperation only where pairs
    genuinely help each other.
13. **Everything goes through the CLI.** Agents, hooks and scripts reach Relo only through the CLI,
    which does the heavy lifting (state, stream-to-phase reduction, rules, sealing, outbox). Server
    logic is essential to the experience but never overbearing: clock, aggregation, delivery,
    authority.

## Decision: entity families

| Family | Entities | State source | Module rule |
|---|---|---|---|
| **Producers** | agent sessions (any agent), scripts (short-lived: CLI, CI, cron), apps (long-lived services: API, webhooks, callbacks) | declared | one module each: identity, CLI or API surface, validation, routes, policy |
| **Harnesses** | Claude Code and Gemini CLI today (Codex, Cursor, OpenCode later), via hooks | observed | one adapter per harness; events only |
| **Owner surfaces** | iPhone app, Lock Screen and Dynamic Island, Watch, Dashboard, notifications, the CLI used by the owner | display derived state only | no surface computes policy, timers or phases |
| **Devices and trust** | phones, computers, linked browsers; keys, approvals | observed (device facts) and the owner's trust decisions | separate from sessions, cards and messages |
| **Messages** | notices, questions, answers (signed by the phone) | declared (asker) and owner (answer) | own lifecycle; reference work, never own or end it |
| **Delivery** | APNs and the outbox, answer wait, answer feed, signed callbacks | infrastructure | own guarantees (retries, ordering, idempotency); never decides content |
| **Derived policy** | `derive()`, the state table, safeguards, constants | derived | one server module; clients display |

**Pairings that cooperate** (narrow, explicit interfaces; neither writes the other's state):
- harness + agent session: reminders, re-injection after compaction, waking with an answer, the subagent guard;
- script + app: credentials with scopes, leases, the answer channels (wait, feed, callback).

## Decision: ownership matrix (code and tests enforce exactly this)

| Entity | Create | Update | End | Read |
|---|---|---|---|---|
| Work and its card | its producer | its producer | its producer; display retirement by derived policy (never a declared outcome) | its producer (own only); the owner |
| Session (observed) | its harness | its harness | its harness, or derived "ended" | the owner |
| Question | its producer | — | answered (owner), expired or canceled (producer) | its producer (own only); the owner |
| Answer | the owner's device (signed) | — | — | the asking producer; the owner |
| Device and trust | the owner | the owner | the owner | the owner; producers read only what sealing needs |
| Derived view | server policy | server policy | — | owner surfaces |

## Decision: the CLI is the edge, the server is clock, aggregator, deliverer and authority

The CLI does the heavy lifting on the computer; the server does only what needs an always-on,
account-wide process. The server never interprets raw activity.

| Responsibility | CLI (edge) | Server |
|---|---|---|
| Declared state working copy (plan, step ids, labels, version, pending questions) | owns it (per-session state file; rebuilt from the server's sealed copy on a miss) | stores the authoritative sealed record |
| Plan rules, content filter, real-words rule | enforces before sending | re-checks structure only (it cannot read sealed text) |
| Encryption | seals and opens | never reads content |
| Reply to the agent (echo, "Owner sees", Next, refusals) | renders | — |
| Observed session state | runs a local state machine per session from the harness adapter's canonical events; subagents roll up locally | stores the last phase and its timestamp per session |
| Network | sends only changes: declared writes and phase transitions, plus a coarse heartbeat while working; durable ordered outbox with idempotency keys | accepts, de-duplicates, stores |
| Reminders and memory restore | local, no network | — |
| Time-based policy (stale, retire, left unfinished, 8 h, waking phones) | — | owns it: it is the only process awake when the computer sleeps |
| Aggregation across computers, sessions, scripts and services (Now, ranking, max 3 cards) | — | owns it |
| Delivery (APNs, outbox, callbacks, answer feed) | — | owns it |
| Authority (credentials and scopes, isolation, idempotency) | presents its credential | enforces |

Consequences: hooks return immediately and the harness never waits on the network; prompts, tool
names and per-tool events never leave the computer; offline work is queued, not lost; `derive()`
stays one server function but takes small, meaningful inputs (declared state, last observed phase and
time, leases) instead of an event stream.

## Decision: rules every module follows

- **Identity per type.** Session keys from the harness; API keys with scopes; service secrets; device
  keys. No type can act as another.
- **Isolation.** Session isolation (agents never see other sessions), account isolation (ADR 0004), the
  encryption boundary (ADR 0005: the server never reads content).
- **Consent.** Anything that changes behaviour beyond the defaults (hook levels, mirroring the agent's
  own questions, callbacks to private addresses) is explicit, explained and reversible.
- **One contract.** Relo has no compatibility matrix ([ARCHITECTURE.md](../ARCHITECTURE.md#one-current-product-contract)): a contract change lands in the server, CLI and apps together, and a field kept only for an already released iPhone build is marked with the build that lets it go.
- **Safeguards and observability.** Every hidden or retired item has a reason the owner can inspect
  (why is this card hidden?), without revealing content.
- **Tests.** Each module alone; contract tests at every interface; invariant tests for every
  principle (one source never writes another's fields; one type cannot call another's surface).

## Checklist for a new module or change

1. Which family and type is it? Which state source does it write? Only that one?
2. What is its identity, and how is it impossible to fake?
3. What is its surface, and what is refused (poka-yoke)?
4. Which shared primitives does it use, and does it add any branching to shared code? (It must not.)
5. Which pairing does it cooperate with, and through which interface?
6. What does the owner see, and what never surfaces (principle 9)? With and without hooks?
7. Which invariant tests prove it?

## Consequences

- New producers or harnesses are added as modules behind the same interfaces; nothing else changes.
- Policy lives in one place, so the owner's screens agree everywhere.
- More modules and interfaces than a single generic layer, in exchange for code that can be read,
  tested and changed one type at a time.
