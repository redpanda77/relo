# ADR 0009: CLI structure

Status: accepted and implemented, 15 October 2026. Applies [ADR 0008](0008-relo-design-framework.md)
(every producer type is its own module; the CLI is the edge) to the code in `packages/cli`.

## Context

The CLI grew one command at a time. A review found the same facts in many places (harness paths and
markers in six files, the instructions block in four, exit codes in prose and code), shared code
asking `caller.type` in branches, a 1,300-line support file, import cycles, a hook path that loaded
the whole CLI, and setup and uninstall written as separate procedures that drifted apart. Each of
these led to real bugs: an install step one harness got and another did not, `relo update`
leaving old instructions behind, a hook paying for modules it never ran.

## Decision: rules

1. **Type-specific code lives in its type's module.** `agent/`, `script/`, `owner/` and `harness/`
   hold everything one caller type does. Shared code (`shared/`, `work/`, `messages/`, `crypto/`,
   `outbox/`, `install/`) never imports `caller.mjs` and never branches on a caller's type; it asks a
   **port** the dispatcher hands it.
2. **Facts once, derived everywhere.** One descriptor per harness, one command registry, one exit-code
   table (`shared/errors.mjs`), one instructions block (`install/block.md`), one version
   (`src/version.mjs`). Help, schema, setup, doctor and detection read them.
3. **Data in descriptors and specs, behaviour in engines.** A descriptor or spec entry holds no logic
   beyond a pure `detect(env)`; the engines (`install/`, the dispatcher, `harness/core`) never name a
   harness or a command.
4. **The hook path pays only for itself.** `relo hook` loads `harness/entry.mjs` and
   `src/hook-deps.mjs`, never the dispatcher, the API client, sealing or agent code.
5. **Setup and uninstall are one plan.** `install/plan.mjs` builds a list of steps from the catalog;
   `relo setup`, `setup --refresh`, `setup --level track`, `relo update` and `relo uninstall` apply or
   reverse the same list, and `--dry-run` prints it.
6. **The import graph is tested.** Reachability, not convention, keeps the rules.

## Decision: layout

| Folder | Holds | Never |
| --- | --- | --- |
| `src/cli.mjs`, `registry.mjs`, `*-spec.mjs` | the dispatcher and the command registry | command logic |
| `agent/` | an agent session's verbs, its session file, guards, the agent message port, the MCP server | script or owner code |
| `script/` | a script or app's verbs, the producer key, `listen`, the script message port | agent code |
| `owner/` | setup, uninstall, update, doctor, login, keys, services, sessions, `relo admin` | being reached from an agent or script path |
| `harness/` | descriptors and hook adapters per harness, the catalog, the hook core and its state machine | declared state, the network |
| `messages/` | notices, questions and cards, through a port | caller types |
| `work/` | the declared work model shared by agents and scripts (plan rules, session store) | caller types |
| `install/` | the engines that write blocks, skills, MCP entries and hooks, and inspect them | harness names |
| `shared/`, `crypto/`, `outbox/` | identical primitives: config, API client, output, options, errors; sealing; the durable queue | caller types |

## Decision: shapes

- **Registry entry** (`work/spec.mjs`, `messages/spec.mjs`, `script/spec.mjs`, `owner/spec.mjs`,
  `harness/spec.mjs`, `root-spec.mjs`): `{ name, alias?, summary, positionals?, options, describe?,
  load, run, auth?, dryRunnable?, port?, ownsRefusals?, ownerOnly?, admin? }`, or
  `variants: { agent, script, owner? }` when each type serves the command itself. The dispatcher
  validates options, resolves the variant for the caller, loads only its module and, with `port`,
  passes that type's message port. Options are described once in `shared/options.mjs`.
- **Harness descriptor** (`harness/adapters/<id>/descriptor.mjs`): `id`, `label`, `aliases`,
  `detect(env)`, `sessionVariable`, `config`, and the files setup writes (`instructions`, `skills`,
  `hooks`, `mcp`). A hook adapter (`index.mjs`) is separate and optional.
- **Message port** (`agent/messages.mjs`, `script/messages.mjs`): `sessionKey`, `waitSeconds`,
  `cardOwner`, `defaults`, `noticeDefaults`, `card`. Shared messages code calls only these.
- **Command outcome**: a command returns or throws; `shared/output.mjs` prints it as text or JSON and
  `EXIT_CODES` maps a failure to its exit status.

## Consequences

Code review rejects:

- a `caller.type` check, or an import of `caller.mjs`, outside the type modules and the dispatcher;
- a harness path, environment marker or label outside its descriptor;
- a second copy of the instructions block, the version, an exit code or an option description;
- an install step written outside `install/plan.mjs`, or one setup writes that uninstall cannot reverse;
- a hook-path import of the dispatcher, the API client, sealing or agent code;
- an import between `agent/` and `script/`, or any import cycle.

Tests pin each of these: `test/reachability.test.mjs` (import graph, cycles),
`test/catalog.test.mjs` (harness facts), `test/registry.test.mjs`, `test/output-contract.test.mjs`,
`test/install-block.test.mjs`, and `test/startup-budget.test.mjs` (the hook loads at most 36 modules
and stays within 20 ms of bare Node; `--version` loads two).

Adding a command is one spec entry and one handler in its type's module; adding a harness is one
descriptor (and, for hooks, one adapter). Neither touches the engines.
