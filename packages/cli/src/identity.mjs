import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, resolve as resolvePath } from "node:path";
import { requireText } from "./args.mjs";
import { UsageError } from "./errors.mjs";
import { definedFields, enumOption, optionalText, shellQuote } from "./support.mjs";

export function activityContext(options, stdin) {
  const inherited = stdinContext(stdin.context);
  if (options.topic !== undefined && options["thread-name"] !== undefined) {
    throw new UsageError("Use either --topic or --thread-name, not both");
  }
  const topic = options.topic ?? options["thread-name"];
  const context = definedFields({
    providerName: options.source === undefined
      ? optionalText(inherited.providerName, "providerName", 80)
      : requireText(options.source, "--source", 80),
    producerKind: enumOption(
      inherited.producerKind,
      "producerKind",
      ["agent", "service", "webhook", "manual"],
    ),
    computer:
      options.computer === undefined
        ? optionalText(inherited.computer, "computer", 120)
        : requireText(options.computer, "computer", 120),
    project:
      options.project === undefined
        ? optionalText(inherited.project, "project", 120)
        : requireText(options.project, "project", 120),
    providerThreadId: optionalText(inherited.providerThreadId, "providerThreadId", 200),
    providerWorkItemId: optionalText(inherited.providerWorkItemId, "providerWorkItemId", 200),
    threadName:
      topic === undefined
        ? optionalText(inherited.threadName, "threadName", 160)
        : requireText(topic, "--topic/--thread-name", 160),
    taskTitle:
      options["task-title"] === undefined
        ? optionalText(inherited.taskTitle, "task-title", 160)
        : requireText(options["task-title"], "task-title", 160),
    threadNameSource: enumOption(
      inherited.threadNameSource,
      "threadNameSource",
      ["provider", "explicit", "fallback"],
    ),
    taskTitleSource: enumOption(
      inherited.taskTitleSource,
      "taskTitleSource",
      ["provider", "prompt_summary", "explicit", "fallback"],
    ),
  });
  return Object.keys(context).length > 0 ? context : undefined;
}

// Fillers that satisfy "non-empty" without identifying anything; the server rejects them too.
export const PLACEHOLDER_PROJECTS = new Set(["project", "codex work", "default", "unknown", "none", "n/a", "untitled"]);

export const PLACEHOLDER_TOPICS = new Set([
  "topic", "task", "codex task", "completion", "unnamed topic", "default", "unknown", "none", "n/a", "untitled",
]);

export function repositoryName(cwd, exists = existsSync) {
  let current = resolvePath(cwd);
  for (let depth = 0; depth < 40; depth += 1) {
    if (exists(`${current}/.git`)) return basename(current);
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * Identity an agent should not have to repeat: RELO_SOURCE/RELO_PROJECT/RELO_TOPIC, then the
 * calling agent recognized from its environment and the git repository it runs in. The topic is
 * never guessed: only the caller knows what the work is about.
 */
export function detectIdentityDefaults(env = process.env, cwd = process.cwd(), exists = existsSync) {
  const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  let agent;
  if (env.CLAUDECODE === "1" || text(env.CLAUDE_CODE_ENTRYPOINT)) agent = "Claude Code";
  else if (Object.keys(env).some((key) => /^CODEX_(?!HOME$)/u.test(key))) agent = "Codex";
  else if (env.OPENCODE === "1") agent = "OpenCode";
  let repository;
  try { repository = repositoryName(cwd, exists); } catch { repository = undefined; }
  return definedFields({
    providerName: text(env.RELO_SOURCE) ?? agent,
    project: text(env.RELO_PROJECT) ?? repository,
    threadName: text(env.RELO_TOPIC),
  });
}

export function creationContext(options, stdin, origin, defaults = {}) {
  const context = activityContext(options, stdin) ?? {};
  const candidates = {
    providerName: context.providerName ?? origin?.sourceInstance ?? defaults.providerName,
    project: context.project ?? origin?.project ?? defaults.project,
    threadName: context.threadName ?? origin?.thread ?? defaults.threadName,
  };
  const usable = (value, placeholders) => typeof value === "string" && value.trim() !== ""
    && !(placeholders?.has(value.trim().toLowerCase()));
  const missing = [
    ...(usable(candidates.providerName) ? [] : ["--source"]),
    ...(usable(candidates.project, PLACEHOLDER_PROJECTS) ? [] : ["--project"]),
    ...(usable(candidates.threadName, PLACEHOLDER_TOPICS) ? [] : ["--topic"]),
  ];
  if (missing.length > 0) {
    // One error naming every gap, with a command to copy: an agent fixes it in a single retry.
    const example = [
      "--source", shellQuote(usable(candidates.providerName) ? candidates.providerName : "<your agent, e.g. Claude Code>"),
      "--project", shellQuote(usable(candidates.project, PLACEHOLDER_PROJECTS) ? candidates.project : "<repository or product>"),
      "--topic", shellQuote(usable(candidates.threadName, PLACEHOLDER_TOPICS) ? candidates.threadName : "<what this work is about>"),
    ].join(" ");
    throw new UsageError(
      `Missing work identity: ${missing.join(", ")}. Every notification, question and Live Activity names a real `
        + "source, project and topic (generic values like \"Project\" or \"Task\" are rejected).",
      {
        missing: missing.map((flag) => flag.slice(2)),
        hint: `Add ${example}, or set RELO_SOURCE / RELO_PROJECT / RELO_TOPIC. See: relo help identity`,
      },
    );
  }
  context.providerName = requireText(candidates.providerName, "--source", 80);
  context.project = requireText(candidates.project, "--project", 120);
  context.threadName = requireText(candidates.threadName, "--topic/--thread-name", 160);
  // A display label alone does not create a normalized Conversation. Manual topics need a stable
  // correlation key; provider-owned opaque thread IDs always take precedence.
  if (context.providerThreadId === undefined && origin === undefined) {
    context.providerThreadId = `cli-topic:${createHash("sha256")
      .update(JSON.stringify([context.providerName, context.project, context.threadName])).digest("hex")}`;
  }
  return context;
}

export function stdinContext(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError("stdin context must be an object");
  }
  return value;
}

/** The agent session running this command, when the agent exposes one. */
export function agentSession(env = process.env) {
  const claude = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (claude) return { agent: "claude-code", id: claude };
  const codex = env.CODEX_THREAD_ID?.trim();
  if (codex) return { agent: "codex", id: codex };
  return null;
}

export function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/**
 * One card per piece of work. Inside an agent session every command lands on that session's
 * card; elsewhere the card is identified by source › project › topic. --name overrides both.
 */
export function cardKey({ name, context, env }) {
  if (name !== undefined) return name;
  const session = agentSession(env);
  if (session) return `session-${session.agent}-${shortHash(session.id)}`;
  if (!context?.providerName || !context?.project || !context?.threadName) return undefined;
  return `work-${shortHash([context.providerName, context.project, context.threadName].join("\u0000"))}`;
}

export function partialIdentity(options, stdin, defaults) {
  const context = stdinContext(stdin.context) ?? {};
  return {
    providerName: options.source ?? context.providerName ?? defaults.providerName,
    project: options.project ?? context.project ?? defaults.project,
    threadName: options.topic ?? options["thread-name"] ?? context.threadName ?? defaults.threadName,
  };
}
