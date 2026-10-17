# Hooks and harnesses

A harness is the program an agent runs in: Claude Code or Gemini CLI today. Hooks are the commands a
harness runs on its own events (a prompt submitted, a tool finished, a turn stopped). Relo can use
them, but they are optional, off by default, and installed by the `guide` and `optimize` depths of
`relo setup --level`. Everything works without them.

The design is [ADR 0007](adr/0007-presence-messages-work-separation.md) and
[ADR 0008](adr/0008-relo-design-framework.md); the state model is in
[ARCHITECTURE.md](ARCHITECTURE.md#state-model).

## What hooks do, and never do

Hooks own one thing: the **observed** state of a session (is it working, waiting on you, stopped,
ended). With hooks on, the owner's Sessions view shows that precisely, and Relo can tell a session
that is working quietly from one that has stopped responding. Hooks also help the agent keep its own
declared state current: they remind it of an open or unrefreshed work and restore its memory of the
work after compaction.

Hooks never create, change or end a work, plan, card, question or notification. A hook that fails,
is missing or is wrong can mislabel a session; it cannot end anyone's work.

## Depths and hook sets

`relo setup --level notify|track|guide|optimize [--approvals on|off] [--agent NAME] [--project]` sets how
deep Relo plugs into each agent. Hooks come with `guide` and `optimize` (one marked entry per event in each
harness's user settings file, or, with `--project`, Claude Code's personal `.claude/settings.local.json`).
Without `--level`, a terminal asks once and a script keeps what is installed.

| Depth | Hook set | Sends to the server |
| --- | --- | --- |
| `notify`, `track` (default) | `off`: nothing installed | nothing; a session's freshness comes from its own `relo` commands |
| `guide`, `optimize` | `presence`: prompt-time context, restore, deliver and refusal reminders, the events that feed the session's phase | phase snapshots only |
| with `--approvals on` | `approvals`: `presence`, plus a `PermissionRequest` hook | phase snapshots, and the permission question you answer |

| Harness | Settings file | Hook sets |
| --- | --- | --- |
| Claude Code (`claude-code`) | `settings.json` in `$CLAUDE_CONFIG_DIR` (default `~/.claude`), or with `--project` the personal `.claude/settings.local.json` | off, presence, approvals |
| Gemini CLI (`gemini`) | `~/.gemini/settings.json` | off, presence |
| OpenCode (`opencode`) | `~/.config/opencode/relo-hooks.json` and its plugin | off, presence (with the continuity roles), approvals |

Relo's entries are the ones whose command starts with `relo hook `. Setup is idempotent, never
touches anyone else's hooks, refuses a settings file that is not plain JSON, and `relo setup
--refresh` rewrites entries an older CLI installed. A project's shared settings file is never
written, so a teammate without `relo` gets no broken hook. Inspect and remove:

```sh
relo setup --show      # the installed depth, hook set and block per harness; writes nothing
relo setup --level track # Relo's entries out of every settings file, and the harness credential revoked
relo sessions        # the owner's Sessions view from hooks (empty without them; refused inside an agent session)
relo outbox status   # what is queued locally and not yet sent
```

In Claude Code the `presence` set installs a `relo hook restore` on SessionStart, `turn` on
UserPromptSubmit, `remind` on Stop and `release` on SessionEnd, plus `guard` before Relo's own
tool calls and `await` after `relo ask`. `guard`, `await` and `release` are accepted but do nothing
yet. The `restore` role adds the session's open work as
context after a start, resume or compaction. The `remind` role adds one soft note, once per change,
when the work looks forgotten (every step done but still open, a count that reached its total, or no
update for a while); it is context for the agent, never a decision, and never blocks the turn.

## What leaves the computer

The privacy rule: **prompts, tool names, tool input or output, notification text and transcript
paths never leave the computer.** The adapter reads only the few fields it maps (session id, event
name, working directory, tool-call id, agent id, start source), and everything else on the hook's
standard input is dropped unread. The server receives, per session:

- a hash of the session id (never the harness's own id), the harness id, the phase, when the phase
  began, last seen, and since when a tool has been running;
- the project, computer and account as keyed handles, and a sealed envelope with their names and the
  session's name for the owner's phones (the name is read from Claude Code's own files on the
  computer), sealed once per session and again only when they change. See
  [ENCRYPTION-PROTOCOL.md](ENCRYPTION-PROTOCOL.md).

Observed-event hooks return at once and print nothing, so the harness never waits on the network;
only the local reminder and restore roles print, one object of added context. A hook that fails
exits 0. `RELO_DEBUG=1` makes `relo hook` log its errors to a file in Relo's state folder.

## How it works

1. The harness runs `relo hook EVENT` and passes its JSON on standard input.
2. The harness's **adapter** maps the native event onto one **canonical event**: `start`, `prompt`,
   `tool_start`, `tool_end`, `wait`, `stop`, `end`, `subagent_start`, `subagent_stop` or `compact`.
   Nothing past this point sees a native field.
3. A **local state machine** per session reduces the events to a phase (`open`, `working`,
   `waiting`, `stopped`, `ended`). Subagents roll up into their session: they never have a phase of
   their own, and while any runs the session is working, even after the main agent's turn ended
   (background agents): it is the owner's turn only once the last one stops.
4. Only when the phase changes, or as a heartbeat at most every 5 minutes while working, the CLI
   queues one snapshot in the durable outbox and starts a background flusher.
5. The flusher sends it to `POST /api/agent-sessions/observed` with the harness credential. An older
   or repeated snapshot (lower `seq`) changes nothing on the server. Entries name the server they
   were queued for and are never sent to another; offline snapshots wait, and a newer snapshot
   replaces an older pending one for the same session.
6. The server stores the last phase and its time, and `derive()` turns phase and time into what the
   owner sees. The server never interprets raw events.

A killed or archived harness runs no SessionEnd hook. So the first hook of a session run notes the process that ran
it (only its parent pid, at no cost to the hook), and the liveness sweep resolves that to the harness's own process
(pid and start time, on this computer only, never sent) and then checks whether it still exists. Two steps, two
cadences: resolving runs on every call and only for sessions not yet resolved, so a harness that dies young is still
known; the alive check runs at most once a minute. A session whose process is gone is ended like a real SessionEnd
(reason "gone", through the same state machine and outbox); its declared work is never touched. Harnesses without a
known process pattern (today only Claude Code and OpenCode have one) are not checked.

Who runs the sweep: the outbox flusher on every flush, and the Relo MCP server (`relo mcp`) once a minute while it
runs. A hook starts the flusher only when it queued a snapshot, so the MCP server's tick is what finds a quit session
when no hook fires anywhere.

**The MCP leave.** `relo mcp` runs as a direct child of its harness, so it lives exactly as long as the session's
process. When its client closes stdin it waits about 1.5 seconds and checks whether its parent process is still
there: a `/mcp` reconnect closes stdin while the harness lives and ends nothing. Only when the parent is gone does it
end every observed session that process ran (reason "mcp"), through the same state machine and outbox, and start the
flusher. This is observed state like a hook's: the MCP server writes nothing else this way (ADR 0008).

**Cleanup.** The sweep deletes the local observed state files and journals of sessions ended more than 8 days ago (a day past the server's retention),
and per-session marker files untouched for 8 days, a bounded number per run.

## The harness credential

Hook traffic has its own credential, so observed state cannot be written with a declared one. It is
minted by `relo setup --level guide` with the owner's CLI login (or by the flusher on its first
send), kept beside the CLI config in a file readable only by you, and carries one scope,
`presence:write`. It can post observed snapshots and nothing else: the server refuses it on every
other route, and refuses the CLI's ordinary credential on the observed route. `relo setup --level track`
revokes it; it can also be listed and revoked under its computer in Connections → Computers or with
`GET`/`DELETE /api/harness-credentials`.

## What works without hooks

Everything a producer declares: `relo work`, questions, notifications, cards, the plan and history.
Freshness then comes from the agent's own writes: a silent agent is dimmed after 20 minutes and
leaves the Lock Screen after 60. What hooks add is evidence ("still working", "waiting on you",
"stopped responding", "session ended"), the reminders, and memory after compaction.

## Adding a harness

Every harness has one folder under `packages/cli/src/harness/adapters/<id>/`. Its `descriptor.mjs`
holds everything Relo knows about it, as data: `id`, `label`, `aliases`, `detect(env)` (the markers it
sets in its agent's shell), `sessionVariable`, `config` (its config folder and the variable that moves
it), and the files setup writes (`instructions`, `skills`, `hooks`, `mcp`). List it in
`harness/catalog.mjs`; caller detection, labels, `relo setup` (and `--mcp`), `relo uninstall`, `relo doctor` and
the schema read it from there ([ADR 0009](adr/0009-cli-structure.md)), and `test/catalog.test.mjs` fails if a harness fact appears anywhere else.

A harness whose hooks Relo uses also has a hook adapter, `index.mjs` in the same folder, registered in
`adapters/index.mjs`. Nothing in `harness/core` changes, and the core never branches on which adapter
it is talking to. An adapter is a frozen object:

| Field | Purpose |
| --- | --- |
| `id`, `label`, `aliases` | From the descriptor: the id used by `--agent`, the display name, other accepted names |
| `events` | Native event name to canonical event; anything unmapped is ignored |
| `accept(event, input)` | Optional filter, for example only notifications that block on the owner count as `wait` |
| `sessionTitle(input, { env, home })` | Optional: the session's human name, read locally from the harness's own files; it leaves the computer only sealed |
| `identity(input)` | The only fields read from the harness's input: `id` (session id), `agent` (set inside a subagent), `toolKey`, `source` (`startup`, `resume`, `clear`, `compact`, `fork`), `stopActive`, `cwd` |
| `harnessEnv(env)` | The environment the harness gives its shell, so the account resolves the same way as for `relo work` |
| `render({ role, context })` | Turns a local role's neutral outcome into the harness's output format, or nothing if it cannot |
| `install` | `format: "json-hooks-map"`, the `global(probe)` and `project(probe)` settings paths (from the descriptor's `hooks`), `levels` (including `off`), `recommended`, `sending` (the levels that send snapshots), `eventOrder`, and `entries(level)`, the exact hook groups per native event |

Rules that tests enforce (`packages/cli/test/harness-invariants.test.mjs`, `harness-levels.test.mjs`):

- every hook command is `relo hook NAME` or `relo hook NAME --agent ID`;
- adapters do no I/O: no network, no outbox, no API client; the core owns state and transport;
- only canonical events leave the adapter, and no prompt, tool name, tool I/O, message or transcript
  path can reach the outbox, the server or a hook file;
- a hook returns in well under 50 ms with the network down.

If the harness cannot name its own events or cannot run a command on them, there is no adapter to
write; such a harness keeps working through the declared commands alone.
