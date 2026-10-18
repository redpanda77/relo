// Notices, questions and the card commands: the messages a producer sends the owner. Each has a variant
// per producer type with its message port (agent/ or script/messages.mjs).
import { ASK, IDENTITY } from "../shared/options.mjs";

const AGENT_PORT = () => import("../agent/messages.mjs");
const SCRIPT_PORT = () => import("../script/messages.mjs");
const ACTIVITY = { load: () => import("./activity.mjs"), run: "runActivityCommand" };
const AGENT = { load: () => import("../agent/index.mjs"), run: "runAgentCommand" };
const MESSAGES = { load: () => import("./notify.mjs"), run: "runNotifyCommand" };

export const MESSAGE_COMMANDS = [
  { name: "activity end", admin: true, describe: { progress: "A percent (40%), a fraction 0 to 1 or a count done/total (3/10). Never a guess from time; a bare number above 1 is rejected as ambiguous." }, summary: "Finish this work's card. Without --status it reads 'Complete' with a success icon.", positionals: "[CARD]",
    options: ["dry-run", "name", "status", "detail", "clear-detail", "progress", "clear-progress", "symbol", "accent-color", "dismiss-after",
      "if-sequence", "idempotency-key", "stdin"], variants: { agent: AGENT, script: { ...ACTIVITY, auth: "client", dryRunnable: true, port: SCRIPT_PORT }, owner: { ...ACTIVITY, auth: "client", dryRunnable: true, port: SCRIPT_PORT } } },
  { name: "ask", summary: "Ask on this work's card and wait for the answer (inside a session, up to 100s). It never starts a card: with none running the question goes out as a notification with the answer buttons. The question is one line of at most 120 characters; the why and the risk go in --detail. Exit 0 approved/yes/chosen, 5 denied/no, 4 still open: run `relo interaction wait ID`, 8 closed without an answer (expired, canceled): do not act.",
    positionals: "QUESTION", identity: true, options: ASK, variants: { agent: { ...MESSAGES, auth: "client", dryRunnable: true, port: AGENT_PORT }, script: { ...MESSAGES, auth: "client", dryRunnable: true, port: SCRIPT_PORT } } },
  { name: "notify send", alias: "notify", summary: "Sparingly: a one-shot message about a finished outcome. Never a question. Inside a session the topic comes from the session's card.",
    positionals: "BODY...", identity: true,
    options: ["dry-run", "title", "summary", "format", "markdown", "image", "url", "device", "idempotency-key", ...IDENTITY, "stdin"], variants: { agent: { ...MESSAGES, auth: "client", dryRunnable: true, port: AGENT_PORT }, script: { ...MESSAGES, auth: "client", dryRunnable: true, port: SCRIPT_PORT } } },
  { name: "notify withdraw", summary: "Remove a delivered notification from the phone.", positionals: "ID", options: ["idempotency-key"], variants: { agent: { ...MESSAGES, auth: "client", port: AGENT_PORT }, script: { ...MESSAGES, auth: "client", port: SCRIPT_PORT } } },
  { name: "activity status", admin: true, ownerOnly: true, summary: "This work's card, if one is running.", positionals: "[CARD]",
    options: ["name", "source", "project", "topic", "thread-name", "stdin"], variants: { agent: AGENT, script: { ...ACTIVITY, auth: "client", port: SCRIPT_PORT }, owner: { ...ACTIVITY, auth: "client", port: SCRIPT_PORT } } },
  { name: "activity diagnose", describe: { "wait": "Wait for the phone to report the card.", "timeout": "How long --wait waits (default 30s)." },  admin: true, ownerOnly: true, summary: "Explain why a card is or is not on the phone.", positionals: "[CARD]",
    options: ["name", "wait", "timeout"], variants: { agent: AGENT, script: { ...ACTIVITY, auth: "client", port: SCRIPT_PORT }, owner: { ...ACTIVITY, auth: "client", port: SCRIPT_PORT } } },
  { name: "activity get", admin: true, ownerOnly: true, summary: "Read a card by ID or name (even an ended one); with no CARD, the same as status.", positionals: "[CARD]",
    options: ["name", "source", "project", "topic", "thread-name", "stdin"], variants: { agent: AGENT, script: { ...ACTIVITY, auth: "client", port: SCRIPT_PORT }, owner: { ...ACTIVITY, auth: "client", port: SCRIPT_PORT } } },
  { name: "activity list", describe: { "limit": "How many cards to list (1 to 100, default 10)." },  admin: true, ownerOnly: true, summary: "List recent cards, newest first: id, state, title, status, step, progress, updatedAt. --full for everything.", options: ["limit"], variants: { agent: AGENT, script: { ...ACTIVITY, auth: "client", port: SCRIPT_PORT }, owner: { ...ACTIVITY, auth: "client", port: SCRIPT_PORT } } },
  { name: "interaction get", summary: "Read a question's state and answer.", positionals: "ID", options: [], variants: { agent: { ...MESSAGES, auth: "client", port: AGENT_PORT }, script: { ...MESSAGES, auth: "client", port: SCRIPT_PORT } } },
  { name: "interaction wait", describe: { timeout: "How long to wait for the answer (default 60s; 100s inside a session; at most 1h). Any length works: the wait runs in slices of 90s. Exit 4 means still open: run it again." }, summary: "Resume waiting for an answer (default 60s; 100s inside a session).", positionals: "ID", options: ["timeout"], variants: { agent: { ...MESSAGES, auth: "client", port: AGENT_PORT }, script: { ...MESSAGES, auth: "client", port: SCRIPT_PORT } } },
  { name: "interaction cancel", summary: "Withdraw a pending question.", positionals: "ID", options: [], variants: { agent: { ...MESSAGES, auth: "client", port: AGENT_PORT }, script: { ...MESSAGES, auth: "client", port: SCRIPT_PORT } } },
];
