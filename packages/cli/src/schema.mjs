// Machine-readable command reference for agents: `relo schema --json`.
// test/schema.test.mjs pins every command's option list to what the CLI actually accepts.

const text = (description, extra = {}) => ({ type: "string", description, ...extra });
const flag = (description) => ({ type: "boolean", description });
const choice = (values, description, extra = {}) => ({ type: "enum", values, description, ...extra });
const duration = (description, extra = {}) => ({ type: "duration", format: "N[s|m|h|d]", description, ...extra });

export const OPTIONS = {
  source: text("Sender name shown on the phone, e.g. Claude Code or Release bot. Auto-detected for known agents.", { maxLength: 80 }),
  project: text("Project the message is filed under. Defaults to the git repository name.", { maxLength: 120 }),
  topic: text("Thread within the project, e.g. a task or PR name. Messages with the same topic group together.", { maxLength: 160 }),
  "thread-name": text("Alias for --topic.", { maxLength: 160 }),
  "task-title": text("Short title for the current task.", { maxLength: 160 }),
  computer: text("Machine name shown with the message.", { maxLength: 120 }),
  title: text("Message or activity title.", { maxLength: 80 }),
  summary: text("Short banner text for a long body; the full body stays readable in the app.", { maxLength: 240 }),
  format: choice(["text", "markdown"], "How the body is rendered in the app."),
  markdown: flag("Shorthand for --format markdown."),
  image: text("Public https:// image shown with the message and as the sender avatar.", { format: "url", maxLength: 2048 }),
  url: text("Opened from the message: https:// link, an app link (your-app://path), or shortcuts://run-shortcut?name=...", { format: "url", maxLength: 2048 }),
  device: text("Target one phone by ID (repeatable). Omit to reach every phone.", { repeatable: true }),
  "idempotency-key": text("Retry-safe key: a replay returns the first result without a second push.", { pattern: "^[A-Za-z0-9._:-]{1,200}$" }),
  stdin: flag("Read a JSON object from stdin; flags win over its fields."),
  type: choice(["approval", "yes-no"], "Answer type."),
  approval: flag("Approve/Deny buttons."),
  "yes-no": flag("Yes/No buttons."),
  "no-wait": flag("Return as soon as the question is on the card instead of waiting for the answer."),
  "expires-in": duration("How long the question stays answerable (default and maximum 5m; unanswered, the card ends) or the card stays live (default 8h)."),
  timeout: duration("How long to wait locally (default: --expires-in). The question stays answerable until it expires."),
  wait: flag("activity diagnose: wait for the phone to report the card."),
  style: choice(["standard", "ring", "hero", "terminal", "steps", "approval", "shell", "verdict", "signal"],
    "Layout. Activities: standard|ring|hero|terminal|steps. Live Activity questions: approval|shell|verdict|signal."),
  "primary-label": text("Primary button label on a Live Activity question.", { maxLength: 24 }),
  "secondary-label": text("Secondary button label on a Live Activity question.", { maxLength: 24 }),
  privacy: choice(["standard", "private"], "private: the phone shows only 'Private activity'; title, status and progress are never stored or sent, and the card cannot carry questions."),
  "correlation-id": text("Your own ID, echoed back on the answer callback.", { maxLength: 100 }),
  "callback-url": text("Public https:// endpoint that receives the answer as a POST (retried up to 5 times).", { format: "url" }),
  "callback-token-file": text("File holding the bearer token sent with the callback (16-512 characters)."),
  name: text("Pin an explicit card name instead of the session or topic.", { maxLength: 100 }),
  replace: flag("End whatever activity occupies the phone (or holds this name) before starting."),
  status: text("Short state line.", { maxLength: 60 }),
  detail: text("Secondary line.", { maxLength: 240 }),
  "clear-detail": flag("Remove the detail line."),
  progress: { type: "number", minimum: 0, maximum: 1, description: "Progress from 0 to 1." },
  "clear-progress": flag("Remove progress."),
  "progress-label": text("Label next to the progress value.", { maxLength: 32 }),
  step: text("Step label, in order (repeatable, up to 8).", { repeatable: true, maxLength: 40 }),
  "step-current": { type: "integer", minimum: 1, maximum: 8, description: "1-based current step." },
  symbol: choice(["terminal", "code", "build", "success", "warning"], "Activity icon."),
  preset: choice(["automatic", "standard", "terminal", "steps"], "Presentation preset."),
  theme: choice(["system", "light", "dark"], "Activity color theme."),
  "accent-color": text("Accent color.", { pattern: "^#[0-9A-Fa-f]{6}$" }),
  "stale-after": duration("Mark the card out of date after this long without an update (default 20m); it ends 10 minutes later."),
  "if-sequence": { type: "integer", minimum: 0, description: "Apply only if the activity is still at this sequence." },
  "dismiss-after": duration("How long the finished card lingers (0 to 4h)."),
  limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size." },
  "page-size": { type: "integer", minimum: 1, maximum: 100, description: "Page size." },
  notification: text("Notification ID filter."),
  cursor: text("Pagination cursor from a previous page."),
  "secret-file": text("Write the new webhook URL (a secret) to this file instead of stdout."),
  "api-url": text("Relo server origin for first login.", { format: "url" }),
  "client-name": text("Label for this login in the dashboard."),
  scope: text("Narrow the login to these scopes (repeatable).", { repeatable: true }),
  open: flag("Open the browser for sign-in."),
  "no-open": flag("Print the sign-in link without opening a browser."),
  smoke: flag("Also send a real test notification."),
};

const IDENTITY = ["source", "project", "topic", "thread-name", "task-title", "computer"];
const ASK = ["type", "approval", "yes-no", "expires-in", "timeout", "no-wait", "primary-label", "secondary-label",
  "device", "idempotency-key", "stdin", "name", ...IDENTITY, "correlation-id", "callback-url", "callback-token-file"];
const START = ["name", "replace", "title", "status", "detail", "progress", "progress-label", "step", "step-current", "symbol",
  "style", "preset", "theme", "accent-color", "privacy", "expires-in", "stale-after", "device", "idempotency-key", ...IDENTITY, "stdin"];

export const COMMANDS = [
  { name: "activity start", summary: "Start this work's Live Activity card, or update it if it is already running. The default tool.",
    identity: true, options: START },
  { name: "activity update", summary: "Change this work's card; send only what changed.", positionals: "[CARD]",
    options: ["name", "title", "status", "detail", "clear-detail", "progress", "clear-progress", "progress-label", "step",
      "step-current", "symbol", "style", "preset", "accent-color", "stale-after", ...IDENTITY, "if-sequence", "idempotency-key", "stdin"] },
  { name: "activity end", summary: "Finish this work's card. Without --status it reads 'Complete' with a success icon.", positionals: "[CARD]",
    options: ["name", "status", "detail", "clear-detail", "progress", "clear-progress", "symbol", "accent-color", "dismiss-after",
      "if-sequence", "idempotency-key", "stdin"] },
  { name: "ask", summary: "Ask on this work's card and wait for the answer. Exit 0 approved/yes, 5 denied/no, 4 no answer in time.",
    positionals: "QUESTION", identity: true, options: ASK },
  { name: "notify send", alias: "notify", summary: "Sparingly: a one-shot message about a finished outcome. Never a question.",
    positionals: "BODY...", identity: true,
    options: ["title", "summary", "format", "markdown", "image", "url", "device", "idempotency-key", ...IDENTITY, "stdin"] },
  { name: "notify withdraw", summary: "Remove a delivered notification from the phone.", positionals: "ID", options: ["idempotency-key"] },
  { name: "activity status", summary: "This work's card, if one is running.", positionals: "[CARD]",
    options: ["name", "source", "project", "topic", "thread-name", "stdin"] },
  { name: "activity diagnose", summary: "Explain why a card is or is not on the phone.", positionals: "[CARD]",
    options: ["name", "wait", "timeout"] },
  { name: "activity get", summary: "Read a card by ID or name.", positionals: "CARD", options: ["name"] },
  { name: "activity list", summary: "List recent cards.", options: ["limit"] },
  { name: "interaction get", summary: "Read a question's state and answer.", positionals: "ID", options: [] },
  { name: "interaction wait", summary: "Resume waiting for an answer.", positionals: "ID", options: ["timeout"] },
  { name: "interaction cancel", summary: "Withdraw a pending question.", positionals: "ID", options: [] },
  { name: "devices list", summary: "List signed-in phones and their IDs.", options: ["page-size"] },
  { name: "services create", summary: "Create a webhook service; returns a secret webhook URL.", options: ["title", "image", "url", "stdin", "secret-file"] },
  { name: "services list", summary: "List webhook services (without their secrets).", options: [] },
  { name: "auth login", summary: "Sign in through the browser.", options: ["api-url", "client-name", "scope", "expires-in", "timeout", "open", "no-open"] },
  { name: "auth status", summary: "Show the active credential and where it came from.", options: [] },
  { name: "auth logout", summary: "Revoke and remove the local credential.", options: [] },
  { name: "doctor", summary: "Check config, server, auth and phone readiness.", options: ["smoke"] },
  { name: "delivery reconcile", summary: "Operator recovery for an ambiguous push.", internal: true, positionals: "JOB_ID mark-accepted|retry|cancel", options: [] },
  { name: "evidence timeline", summary: "Delivery evidence for debugging.", internal: true, options: ["notification", "limit", "cursor"] },
  { name: "evidence metrics", summary: "Delivery metrics for debugging.", internal: true, options: [] },
  { name: "help", summary: "Short guide; `help identity` or `help all` for more.", positionals: "[identity|all]", options: [] },
  { name: "schema", summary: "This machine-readable reference.", options: [] },
];

export function commandSchema({ version, exitCodes }) {
  return {
    schemaVersion: 1,
    cli: "relo",
    version,
    model: "Live Activity cards are the default: one card per agent session (Claude Code CLAUDE_CODE_SESSION_ID, Codex "
      + "CODEX_THREAD_ID) or per source/project/topic outside a session. Questions appear on that card. Notifications are "
      + "one-shot outcomes, used sparingly, never questions.",
    output: "Every command prints one JSON object on stdout: {ok,command,data} or {ok:false,error:{code,message,hint?,details?}}. "
      + "Errors print as JSON whenever stdout is not a terminal or --json is passed; diagnostics go to stderr.",
    identity: {
      required: ["source", "project", "topic"],
      appliesTo: COMMANDS.filter((command) => command.identity).map((command) => command.name),
      resolution: ["flags", "--stdin JSON or --origin-file", "RELO_SOURCE / RELO_PROJECT / RELO_TOPIC",
        "the calling agent (source) and git repository (project)"],
    },
    environment: {
      RELO_TOKEN: "Credential for CI and containers; overrides the config file. Requires RELO_API_URL.",
      RELO_API_URL: "Relo server origin.",
      RELO_SOURCE: "Default --source.", RELO_PROJECT: "Default --project.", RELO_TOPIC: "Default --topic.",
      RELO_CONFIG_PATH: "Alternate config file location.",
    },
    exitCodes,
    globalOptions: { json: flag("Force the JSON envelope (default when piped)."), help: flag("Show help.") },
    commands: COMMANDS.map(({ options, ...command }) => ({
      ...command,
      options: Object.fromEntries(options.map((name) => [name, OPTIONS[name]])),
    })),
  };
}
