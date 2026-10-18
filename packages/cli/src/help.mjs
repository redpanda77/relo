import { EXIT_CODES, exitCodeLine } from "./shared/errors.mjs";
import { HARNESSES, SESSION_VARIABLES } from "./harness/catalog.mjs";
import { optionsOf, COMMANDS } from "./registry.mjs";
import { OPTIONS, optionUsage } from "./shared/options.mjs";
import { FACTS, factText, shortDuration } from "./shared/facts.mjs";


// What help says about harnesses comes from their descriptors (harness/catalog.mjs), never written here.
const detected = HARNESSES.filter((harness) => harness.detect);
const DETECTED = detected.map((harness) => harness.label).join(", ");
const WITHOUT_SESSION = detected.filter((harness) => !harness.sessionVariable).map((harness) => harness.label).join(", ");
const CONFIG_FOLDERS = detected.filter((harness) => harness.config?.variable).map((harness) => harness.config.variable).join(" / ");
const SESSION_NAMES = SESSION_VARIABLES.map(([, variable]) => variable).join(", ");

export const GUIDE = `Relo puts your work on the owner's iPhone: one open work per session, shown while it matters.

  relo work start --goal "Fix the login crash" --plan "Reproduce the crash,Find the cause,Choose the fix"
  relo work update --status "Reproduced on iOS 17" --next-step
  relo work update --add "Patch token refresh,Run the tests"     # the plan grows in place
  relo ask "Deploy to production?" --approval
  relo work deliver --outcome "Login fixed: token refresh patched and tested"   # this request is done; the work stays open
  relo work start --round "Add a regression test" --plan "Write it,Run it"   # the owner's follow-up, same goal
  relo work finish --outcome "Login fixed and covered by a test"   (--failed | --dropped)
  relo work handoff --next "Wire the CLI verb"                    # heavy context or before /clear: a fresh session goes on
  relo work start --from rh_…                                    # in the fresh session: take the handed-off work over
  relo state                                                     # what this session has open
  relo admin works                                               # only when the owner asks: every session's work
Steps are milestones in order. Parallel work (subagents, several jobs) is one step with a count: --progress 2/6.
A counted job without a plan: --progress 3/10. --plan "…" lists what is left (done steps stay; left-out steps
are skipped); --step "…" jumps; update applies --next-step, --plan, --add, --step, --detail, --progress, then text.
A repeat start continues the open work; another goal: start --new (the old one is parked: relo work resume).
Done and nothing left: finish (Done; a later start --round starts a fresh card). deliver = this request is done (their
turn, one quiet notification); the owner must act mid-plan: ask or --waiting. deliver is refused while top-level steps
are open (--drop-rest skips them; a start --round without --plan carries them on). Nest steps only when one
cannot be finished in one go: --add "…" --under s3 (--after s3 for siblings), or indent lines two spaces in a newline --plan; --detail "…"
explains the current step. Read relo output whole (never through tail, head or grep): find "Owner sees:".
Ending a turn while CI, a review or a background job runs: --waiting "the deploy" (--not-waiting clears it).
Away: relo work pause --status "…". Every command prints the plan, what the owner sees and the exact next
command; a refusal is three lines (Refused / State / Next).
No session id (${WITHOUT_SESSION}): pass the handle start prints as --work <handle>.
ask also takes --yes-no. In a session it waits up to ${factText("question.agentWaitSeconds", { short: true })}: exit 4 means still open (relo interaction wait ID).
The deliver or finish outcome is the notification; relo notify only when no work is open.

Output: relo work and relo state print their echo; the rest one compact JSON line. --json: always JSON;
--full: the whole server reply. Errors print once, with a hint.
Exit: ${exitCodeLine([0, 5, 4, 8])}
      ${exitCodeLine([2, 3, 1, 6, 7])}
relo doctor: ready? (follow next.run) · relo auth login (agents: prints the link, then relo auth login --wait) · relo test (once)
relo setup: tells this computer's agents about Relo (the owner's command: block and skill per harness) · relo uninstall
relo keys status: end-to-end encryption is automatic · a new phone waits: relo keys approve PHONE (a person), or approve it on your trusted iPhone → Settings → Devices
relo update [--check] [--rollback]: new CLI release (install-script CLIs update themselves; run it when a reply says the CLI is behind)
relo setup: owner's choice, never automatic (--level notify|track|guide|optimize: how deep, --show: what is installed; --mcp: MCP server entry for shell-less harnesses) · relo sessions · --dry-run checks a command without sending · relo help identity · relo help all (every flag) · relo schema [COMMAND] (JSON)`;

export const IDENTITY_HELP = `Work identity: source > project > topic, plus where it ran: computer and account

The first non-empty value wins:
  1. Flags: --source, --project, --topic (--thread-name is an alias), --computer, --account
  2. --stdin JSON: context.providerName, project, threadName, computer, account
  3. Environment: RELO_SOURCE, RELO_PROJECT, RELO_TOPIC, RELO_COMPUTER, RELO_ACCOUNT
  4. Detection: source from the calling agent (${DETECTED}; any other
     harness sets RELO_SOURCE); project from the git
     repository; computer from the Mac's name (scutil) or the hostname; account from "relo account NAME",
     else the name of a custom ${CONFIG_FOLDERS} folder (~/.claude-work -> "work").
     Nothing in an agent's config folder is ever read, only its name.

The topic is not guessed from your task. Inside a session it defaults to the session's name (else its work's goal); otherwise you give it. Name the work as the owner would ("Release 0.7.55", "Homepage redesign"),
not a step ("Running tests"). Generic values ("Project", "Task", "Unknown") are rejected.
Computer and account are optional context: omitted when nothing identifies them.

Cards: inside a session (${SESSION_NAMES}; RELO_SESSION=<stable id> only outside a detected
harness; nested harness ids count as none) the card belongs to the session, so every command updates the same card even if the topic wording changes. Elsewhere the
card is source > project > topic. --name pins an explicit card name.

Missing fields fail before any request (exit 2); the hint is a command with only the missing flags.
relo notify inside a session takes source, project and topic from the session's card when it is running.`;

/** `relo help all`: every public command by section, rendered from the registry, then what no single command owns. */
const SECTIONS = [
  ["The work: one open work per session (agents), or per producer key (scripts and apps)", ["work", "state", "run"]],
  ["Questions, on this session's open work", ["ask", "interaction", "listen"]],
  ["Notifications: sparingly, for finished outcomes", ["notify"]],
  ["Live Activity cards: the owner's terminal (relo admin offers them across sessions)", ["activity"]],
  ["Sign-in, phones and checks", ["auth", "test", "doctor", "devices", "account", "services"]],
  ["This computer: the owner's commands (an agent runs them only when asked)", ["setup", "uninstall", "update", "config", "mcp", "hook", "statusline"]],
  ["End-to-end encryption keys", ["keys"]],
  ["Owner administration: across sessions (an agent only when the owner asks)", ["admin", "sessions"]],
  ["Reference", ["help", "schema"]],
];
const WIDTH = 112;

/** Words wrapped to WIDTH, every line after the first indented by `indent`. */
function wrap(words, first, indent) {
  const lines = [];
  let line = first;
  for (const word of words) {
    if (line.trim() && line.length + 1 + word.length > WIDTH) { lines.push(line); line = indent + word; }
    else line = line.trim() ? `${line} ${word}` : `${line}${word}`;
  }
  lines.push(line);
  return lines;
}

/** The name a person types: the shorter of a command's name and its alias (`relo notify`, not `relo notify send`). */
const typedName = (entry) => (entry.alias && entry.alias.length < entry.name.length ? entry.alias : entry.name);

function commandLines(entry) {
  const head = [`relo ${typedName(entry)}`, ...(entry.positionals ? [entry.positionals] : [])];
  const flags = optionsOf(entry).map((name) => `[${optionUsage(name, entry.types?.[name])}]`);
  return [...wrap([...head.slice(1), ...flags], `  ${head[0]}`, "      "), ...wrap(entry.summary.split(" "), "      ", "      ")];
}

const NOTES = `Identity (notify, ask): --source NAME --project NAME --topic NAME --computer NAME --account NAME. Source, project,
  computer and account are automatic; the topic is yours (relo help identity). A harness Relo does not detect sets
  RELO_SOURCE="<harness>" and RELO_SESSION=<stable id> (one card per session; questions wait up to ${factText("question.agentWaitSeconds", { short: true })}).

Questions: exit 0 approved/yes/chosen, 5 denied/no, 4 still open (relo interaction wait ID), 8 closed without an answer
  (expired, canceled): do not act. A question never starts or ends a work's card: with none running it goes out as a
  notification with the answer buttons. Answers also arrive by --callback-url, relo listen or relo interaction wait ID.

Cards on the phone: a card's first appearance alerts once (the phone needs an alert to start a Live Activity) and a question on a card alerts again; other updates are silent. A card that stops
  updating is dimmed after ${factText("card.freshSeconds")} and leaves the Lock Screen after ${FACTS.card.retireSeconds / 60}.

Links (--url): https:// pages, an app scheme (your-app://incidents/42) or shortcuts://run-shortcut?name=...
  http:, javascript:, data:, file:, blob: and about: are rejected. Images (--image): public https://.

Callbacks (--callback-url): Relo POSTs the answer with "Authorization: Bearer <token>" (signed: Relo-Signature,
  Relo-Delivery-Id), retried ${FACTS.callback.retryDelaysSeconds.length + 1} times over about ${FACTS.callback.giveUpSeconds / 3600} hours (${FACTS.callback.retryDelaysSeconds.slice(0, 4).map(shortDuration).join(", ")}, then up to a day apart). Expired or
  canceled questions never call back.

Limits: ${FACTS.requests.loginPerMinute} writes a minute per login, ${FACTS.requests.accountPerMinute} per account; a 429 carries retryAfterSeconds. A write (it has an idempotency
  key) that gets a 429 with retryAfterSeconds of 10 or less is retried once after that wait; anything longer, and any
  wait for an answer, returns the error with its hint. CI and containers: RELO_TOKEN and RELO_API_URL override the config.

Output: relo work and relo state print their echo; the rest one compact JSON line. Errors print once: JSON on stdout
  when piped or with --json, plain text on stderr at a terminal.
Global options:
  --json      Force JSON output and errors (automatic when piped)
  --full      Print the whole server reply instead of the compact line
  --help      Show help          --version   Show the CLI version

Exit codes:
${EXIT_CODES.map(({ code, meaning }) => `  ${code} ${meaning}`).join("\n")}

Supplied idempotency keys use 1-200 characters from A-Z, a-z, 0-9, ., _, :, and -.
Credentials come from the mode-0600 config file (relo auth login) or RELO_TOKEN. Token flags are forbidden.`;

function renderHelpAll() {
  const shown = COMMANDS.filter((entry) => !entry.internal);
  const sections = SECTIONS.map(([title, groups]) => {
    const entries = shown.filter((entry) => groups.includes(entry.name.split(" ")[0]));
    return entries.length ? [title, ...entries.flatMap(commandLines)].join("\n") : undefined;
  }).filter(Boolean);
  const advanced = COMMANDS.filter((entry) => entry.internal).map((entry) => entry.name);
  return [
    "Relo: every command (short version: relo help; one command: relo help COMMAND; as JSON: relo schema)",
    ...sections,
    `Advanced: ${advanced.join(", ")} (relo help COMMAND).`,
    NOTES,
  ].join("\n\n");
}

/** `relo help GROUP`: every command of a group (relo help keys, relo help admin), each with its usage and summary. */
export function groupHelp(group, entries) {
  return [
    `relo ${group}: ${entries.length} commands`,
    "",
    ...entries.flatMap((entry) => commandLines(entry)),
    "",
    `One command and its options: relo help ${group} COMMAND (or relo ${group} COMMAND --help).`,
  ].join("\n")
}

/** The first word of every public command, for the test that each one has a section. */
export const HELP_SECTION_GROUPS = Object.freeze(SECTIONS.flatMap(([, groups]) => groups));

export const HELP = renderHelpAll();

/**
 * `relo COMMAND --help` and `relo help COMMAND`: the command's summary, its usage line and every option it
 * takes for this caller, rendered from its registry entry, so help can never disagree with what is accepted.
 */
export function commandHelp(entry, options) {
  const flags = options.map((name) => optionUsage(name, entry.types?.[name]));
  const usage = [`relo ${entry.name}`, entry.positionals, flags.length ? "[options]" : undefined].filter(Boolean).join(" ");
  const width = Math.min(28, Math.max(0, ...flags.map((flag) => flag.length)) + 2);
  // An entry may describe an option in its own words (`describe`); else the shared definition's.
  const lines = options.map((name, index) => `  ${flags[index].padEnd(width)}${entry.describe?.[name] ?? OPTIONS[name]?.description ?? ""}`);
  return [
    `${usage}${entry.alias ? `   (also: relo ${entry.alias})` : ""}`,
    "",
    entry.summary,
    ...(lines.length ? ["", "Options:", ...lines] : []),
    "",
    "Every command also takes --json, --full and --help. All commands: relo help all; as JSON: relo schema " + entry.name,
  ].join("\n");
}
