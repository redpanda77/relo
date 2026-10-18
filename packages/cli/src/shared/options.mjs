// Every option the CLI documents, once: its type and what it means (relo schema publishes these). Command
// entries (the */spec.mjs files) name the options they take; groups shared by several commands live here too.
import { HARNESSES, SESSION_VARIABLES, harnessLabel } from "../harness/catalog.mjs";
import { COMPUTER_ICONS } from "./computers.generated.mjs";
import { LOGIN_SCOPES, SCOPES } from "./scopes.generated.mjs";

const SERVICE_SCOPES = Object.keys(SCOPES).filter((scope) => SCOPES[scope].kinds.includes("service"));
import { FACTS, factText } from "./facts.mjs";

const MOVABLE_CONFIG = HARNESSES.filter((harness) => harness.detect && harness.config?.variable).map((harness) => `$${harness.config.variable}`).join(", ");
export const SESSION_IDS = SESSION_VARIABLES.map(([id, variable]) => `${harnessLabel(id)} ${variable}`).join(", ");

const text = (description, extra = {}) => ({ type: "string", description, ...extra });
export const flag = (description) => ({ type: "boolean", description });
const choice = (values, description, extra = {}) => ({ type: "enum", values, description, ...extra });
const duration = (description, extra = {}) => ({ type: "duration", format: "N[s|m|h|d]", description, ...extra });

const DEFINITIONS = {
  goal: text("work: the goal, in the owner's words (real words; no placeholders, paths or secrets).", { maxLength: FACTS.work.goalMax }),
  plan: text("work start|update: comma-separated steps (a comma inside brackets or quotes stays in its step), or one per line (a newline-separated list keeps its commas); indent a line two spaces to nest it under the line above (at most three levels). On update it lists what is left: done steps stay, unlisted open steps are skipped, new labels become steps.", { maxLength: 4000 }),
  add: text("work update: comma-separated steps added at the end of the round (a comma inside brackets or quotes stays in its step; one per line keeps its commas, indented to nest); --after puts them after one step, --under inside one.", { maxLength: 4000 }),
  under: text("work update: with --add, the id of the step the new steps go under (s3). Use it only when a step cannot be finished in one go; a finished step gets reopened.", { maxLength: 40 }),
  after: text("work update: with --add, the id of the step the new steps follow, as its siblings (s3).", { maxLength: 40 }),
  "drop-rest": flag("work deliver: deliver although top-level steps are still open: they are skipped (a next round without --plan carries them). Without it such a deliver is refused."),
  detail: text("ask: the question's explanation (why, risk, what changes), markdown up to 4,000 characters, read in Relo.", { maxLength: 4000 }),
  round: text("work start: on a goal whose last round was delivered, the title of the next round (the request, in a few words, up to 80 characters). Without --plan the round carries the unfinished steps of the one before.", { maxLength: FACTS.work.stepLabelMax }),
  next: text("work handoff: what the next session should do, in a few words. Required; it becomes the card's status \"Handing off: …\".", { maxLength: FACTS.work.statusMax - 13 }),
  from: text("work start: take over the work another session of this computer handed off (the handle relo work handoff printed). No --goal needed.", { maxLength: 200 }),
  outcome: text("work finish|deliver: what happened, in the owner's words. Required; it is the notification.", { maxLength: FACTS.work.outcomeMax }),
  failed: flag("work finish: the work did not succeed (the owner gets an alert)."),
  dropped: flag("work finish: the work was abandoned (History only)."),
  waiting: text("work update: declared outside wait, e.g. CI or a review.", { maxLength: FACTS.work.waitingMax }),
  "not-waiting": flag("work update: clear the declared wait."),
  work: text("work finish|resume: a parked work of this session (wrk_…). Callers without a session id pass the handle printed by start."),
  sync: flag("state: ask the server instead of the local copy."),
  source: text("Sender name shown on the phone, e.g. Claude Code or Release bot. Auto-detected for Claude Code, Codex, OpenCode, Gemini CLI and Cursor; any other harness sets RELO_SOURCE=\"<harness>\".", { maxLength: 80 }),
  project: text("Project the message is filed under. Defaults to the git repository name.", { maxLength: 120 }),
  topic: text("Thread within the project, e.g. a task or PR name. Messages with the same topic group together.", { maxLength: 160 }),
  "thread-name": text("Alias for --topic.", { maxLength: 160 }),
  "task-title": text("Short title for the current task.", { maxLength: 160 }),
  computer: text("Computer name shown on the card. Automatic: RELO_COMPUTER, else the Mac's name, else the hostname.", { maxLength: 120 }),
  icon: choice(COMPUTER_ICONS, "setup: the icon this computer shows on your phone and in the Dashboard. Without it, setup asks (at a terminal) or leaves it automatic."),
  account: text(`Agent account shown on the card (e.g. work, personal). Automatic: RELO_ACCOUNT, else \`relo account NAME\` (any harness), else the name of a custom config folder (${MOVABLE_CONFIG}).`, { maxLength: 40 }),
  clear: flag("account: remove the nickname for this agent account."),
  title: text("Message or activity title. Longer text is shortened at a word boundary with an ellipsis, and the reply carries a note.", { maxLength: 80 }),
  summary: text("Short banner text for a long body; the full body stays readable in the app. Longer text is shortened, with a note.", { maxLength: 240 }),
  format: choice(["text", "markdown"], "How the body is rendered in the app."),
  markdown: flag("Shorthand for --format markdown."),
  image: text("Public https:// image shown with the message and as the sender avatar.", { format: "url", maxLength: 2048 }),
  url: text("Opened from the message: https:// link, an app link (your-app://path), or shortcuts://run-shortcut?name=...", { format: "url", maxLength: 2048 }),
  device: text("Target one phone by ID (repeatable). Omit to reach every phone.", { repeatable: true }),
  producer: text("Scripts and apps only (no agent harness): names this job's work so later commands find it (or RELO_SESSION=KEY). Agents never pass it.", { pattern: "^[A-Za-z0-9._:-]{1,100}$" }),
  lease: text("Scripts only: work start|heartbeat keep the work moving without updates for this long (1m to 60m, default 15m).", { pattern: "^\\d+[smh]?$" }),
  "idempotency-key": text("Retry-safe key: a replay returns the first result without a second push.", { pattern: "^[A-Za-z0-9._:-]{1,200}$" }),
  stdin: flag("Read a JSON object from stdin; flags win over its fields."),
  type: choice(["approval", "yes-no", "choice"], "Answer type (choice is implied by --option)."),
  approval: flag("Approve/Deny buttons."),
  "yes-no": flag("Yes/No buttons."),
  yes: flag("keys approve: approve without the [y/N] question (the owner's explicit choice; required without a terminal)."),
  "no-wait": flag("Return as soon as the question is on the card instead of waiting for the answer."),
  "expires-in": duration(`How long the question stays answerable: default ${factText("question.defaultSeconds", { short: true })}, up to the server's limit (${factText("question.serverCapSeconds")} unless the admin changed it). Past ${factText("card.maxSeconds", { short: true })} the card ends and the question keeps waiting in Relo.`),
  "notification-only": flag("ask: send the question as a notification with its answer buttons and never take a Live Activity card (for apps that should not crowd the Lock Screen)."),
  new: flag("work start: start a work for another goal; the open one is parked."),
  since: text("listen: resume after this cursor (from an earlier line) or start at this ISO time. Without it, only new answers."),
  once: flag("listen: one round (up to 60s), then exit."),
  timeout: duration(`ask: how long to wait here for the answer. Default: the shorter of --expires-in and 300s (${factText("question.agentWaitSeconds", { short: true })} inside a session, whose shell tool kills long commands); at most --expires-in. Any length works: the wait runs in slices of 90s. The question stays answerable until it expires: resume with \`relo interaction wait ID\`.`),
  wait: flag("Wait for the result instead of returning at once."),
  option: text("ask: one answer of a choice question (repeat 2-4 times). LABEL, or ID=LABEL to choose the id; labels are one line of up to 24 characters. The reply reports state \"chosen\" with option and label.", { repeatable: true, maxLength: 57 }),
  "primary-label": text("Primary button label on a Live Activity question.", { maxLength: 24 }),
  "secondary-label": text("Secondary button label on a Live Activity question.", { maxLength: 24 }),
  "correlation-id": text("Your own ID, echoed back on the answer callback.", { maxLength: 100 }),
  "callback-url": text(`Public https:// endpoint that receives the answer as a signed POST (retried ${FACTS.callback.retryDelaysSeconds.length + 1} times over about ${FACTS.callback.giveUpSeconds / 3600} hours).`, { format: "url" }),
  "callback-token-file": text("File holding the bearer token sent with the callback (16-512 characters)."),
  name: text("Pin an explicit card name instead of the session or topic.", { maxLength: 100 }),
  status: text("What is happening now, in one short line. Work refuses text over 120 characters; a card shortens longer text and says so in a note.", { maxLength: 120 }),
  "clear-detail": flag("Remove the detail line."),
  progress: { type: "string", description: "A count, done/total (3/10): on a work with a plan it belongs to the current step (parallel work is one step with a count), else to the work (a counted job: 10 images, 400 rows). Never a guess from time; a bare number above 1 is rejected as ambiguous." },
  "clear-progress": flag("Remove progress."),
  step: text("work update: make this step the current one, by id (s3) or by its label.", { repeatable: true, maxLength: 80 }),
  "next-step": flag("work update: finish the current step and start the next."),
  symbol: choice(["terminal", "code", "build", "success", "warning"], "Activity icon."),
  "accent-color": text("Accent color.", { pattern: "^#[0-9A-Fa-f]{6}$" }),
  "if-sequence": { type: "integer", minimum: 0, description: "Apply only if the activity is still at this sequence." },
  "dismiss-after": duration("How long the finished card lingers (0 to 4h)."),
  limit: { type: "integer", minimum: 1, maximum: 100, description: "How many items to return (1 to 100)." },
  "page-size": { type: "integer", minimum: 1, maximum: 100, description: "Page size." },
  notification: text("Notification ID filter."),
  cursor: text("Pagination cursor from a previous page."),
  "secret-file": text("Write the new service secret to this file (mode 0600) instead of printing it."),
  "api-url": text("Relo server origin for first login.", { format: "url" }),
  "client-name": text("Label for this login in the dashboard. Default: this computer's name. A login is replaced when the same name signs in again, so keep names unique per machine.", { maxLength: 80 }),
  scope: text(`Narrow to these scopes (repeatable). A login: ${LOGIN_SCOPES.join(", ")}. A service: ${SERVICE_SCOPES.join(", ")}.`, { repeatable: true }),
  readable: choice(["on", "off"], "services: on an account that requires end-to-end encryption, may this service send readable content (it cannot seal)? Off by default."),
  open: flag("Open the browser for sign-in (with --no-wait, after storing the pending sign-in)."),
  "no-open": flag("Print the sign-in link without opening a browser."),
  smoke: flag("Also send a real test notification."),
  all: flag("admin works: every work of the account, finished ones too, not only open and paused."),
  live: flag("sessions: only the sessions working now or waiting for the owner; the counts still cover every phase."),
  agent: text(`Only this harness (repeat for several; default: every harness found here): ${HARNESSES.filter((harness) => harness.instructions || harness.skills || harness.mcp).map((harness) => harness.id).join(", ")}.`, { repeatable: true }),
  "dry-run": flag("Check everything locally (identity, limits, the plan) and print {ok,dryRun,would:{command,body}}: no request, no login needed."),
  mcp: flag("setup: also write Relo's MCP server entry {command relo, args [mcp]} for each harness with an MCP config (Claude desktop, Cursor and VS Code get node and the script's full path; they do not read the shell PATH)."),
  level: choice(["notify", "track", "guide", "optimize"], "setup: how deep Relo plugs into your agents. notify: questions and notifications only, no cards. track: live cards with plans. guide: track plus continuity across requests, compaction and /clear, and the Sessions view (session hooks). optimize: guide plus lean context and right-sized subagents. Without it, setup keeps what is installed (first install: track), and asks once at a terminal."),
  approvals: choice(["on", "off"], "setup: at guide or optimize, answer permission prompts from your phone and the Dashboard too (the approvals hook set). Without it, setup keeps what is installed."),
  statusline: choice(["on", "off"], "setup: at optimize, wrap Claude Code's status line to read context use and cost (yours keeps printing; uninstall or a shallower depth puts it back). Default on at optimize."),
  agents: choice(["on", "off"], "setup: at optimize, install the relo-explore (small model, read-only) and relo-worker (mid model) subagents in ~/.claude/agents, never over a file of yours. Default on at optimize."),
  "subagent-model": text("setup: at optimize and only when you ask, set CLAUDE_CODE_SUBAGENT_MODEL in Claude Code's settings (haiku, sonnet, opus or a model id); off takes Relo's value out again."),
  modules: text("setup: override the block's modules, comma-separated: notify, reporting, planning, continuity, efficiency (notify and reporting exclude each other). Hooks and the skill still follow --level."),
  show: flag("setup: write nothing; show what is installed per harness (depth, modules, hooks, skill) and the block text. With --level: what that depth would install."),
  profile: text("auth login: store this sign-in under a named profile (e.g. work) instead of the active one. Switch with `relo auth switch NAME` or RELO_PROFILE=NAME.", { maxLength: 40, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$" }),
  refresh: flag("setup: re-render what is installed (instruction blocks, older skill copies, hook entries, MCP paths) for this CLI; adds nothing. relo update runs it."),
  apply: flag("uninstall: remove what it lists (without it, uninstall only lists)."),
  again: flag("test: run the phone test again even if it was verified before."),
  check: flag("update: only report the latest release; install nothing."),
  auto: flag("update: the background run a newer server CLI starts by itself (one at a time, quiet); not for people."),
  rollback: flag("update: reinstall the newest earlier release stored in ~/.local/share/relo/cli-releases/ (checksum re-verified)."),
  version: text("update: install this release (0.10.0, v0.10.0 or cli-v0.10.0) instead of the latest. Elsewhere `relo --version` prints this CLI's version."),
};

/** The placeholder help shows after an option that takes a value (`--project NAME`); else TEXT, N or the choices. */
const METAVARS = {
  source: "NAME", project: "NAME", topic: "NAME", "thread-name": "NAME", computer: "NAME", account: "NAME", name: "NAME",
  "client-name": "NAME", profile: "NAME", agent: "NAME", producer: "KEY", "idempotency-key": "KEY", image: "URL", url: "URL",
  "callback-url": "URL", "api-url": "URL", "callback-token-file": "PATH", "secret-file": "PATH", device: "ID",
  "correlation-id": "ID", notification: "ID", work: "WORK", option: "LABEL", progress: "n/m", lease: "DURATION",
  limit: "1..100", scope: "SCOPE", version: "X", since: "CURSOR|TIME", cursor: "CURSOR", step: "STEP",
  plan: '"A,B,C"', add: '"A,B"', level: "LEVEL", approvals: "on|off", statusline: "on|off", agents: "on|off", "subagent-model": "MODEL|off", modules: "A,B",
};

export const OPTIONS = Object.freeze(Object.fromEntries(Object.entries(DEFINITIONS)
  .map(([name, definition]) => [name, METAVARS[name] ? { ...definition, metavar: METAVARS[name] } : definition])));

/** `--name METAVAR` as help shows it: the metavar, the choices, DURATION, N or TEXT; a flag alone. */
export function optionUsage(name, type = OPTIONS[name]?.type) {
  const definition = OPTIONS[name];
  if (!definition) return `--${name}`;
  if (type === "boolean") return definition.type === "boolean" && definition.metavar ? `--${name} ${definition.metavar}` : `--${name}`;
  const value = definition.metavar ?? (definition.type === "enum" ? definition.values.join("|")
    : definition.type === "duration" ? "DURATION" : definition.type === "integer" ? "N" : "TEXT");
  return `--${name} ${value}`;
}

export const IDENTITY = ["source", "project", "topic", "thread-name", "task-title", "computer", "account"];
export const ASK = ["dry-run", "type", "approval", "yes-no", "option", "detail", "notification-only", "expires-in", "timeout", "no-wait", "primary-label", "secondary-label",
  "device", "idempotency-key", "stdin", "name", ...IDENTITY, "correlation-id", "callback-url", "callback-token-file"];
