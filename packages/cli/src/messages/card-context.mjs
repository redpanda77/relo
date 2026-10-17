// What a card, notice or question is about and whose it is: source › project › topic, and the card key that
// keeps one card per piece of work. Used by relo notify, ask and the activity commands.
import { createHash, createHmac } from "node:crypto";
import { loadIdentitySync, subkey } from "../crypto/keystore.mjs";
import { UsageError } from "../shared/errors.mjs";
import { definedFields, enumOption, optionalText, requireText, shellQuote } from "../shared/validate.mjs";

function activityContext(options, stdin) {
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
    account:
      options.account === undefined
        ? optionalText(inherited.account, "account", 40)
        : requireText(options.account, "--account", 40),
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
const PLACEHOLDER_PROJECTS = new Set(["project", "codex work", "default", "unknown", "none", "n/a", "untitled"]);

const PLACEHOLDER_TOPICS = new Set([
  "topic", "task", "codex task", "completion", "unnamed topic", "default", "unknown", "none", "n/a", "untitled",
]);

/** `example` is the command being run, e.g. `relo ask "Deploy?" --approval`, so the hint can finish it. */
export function creationContext(options, stdin, origin, defaults = {}, example) {
  const context = activityContext(options, stdin) ?? {};
  for (const field of ["computer", "account"]) {
    if (context[field] === undefined && defaults[field] !== undefined) context[field] = defaults[field];
  }
  const candidates = {
    providerName: context.providerName ?? origin?.sourceInstance ?? defaults.providerName,
    project: context.project ?? origin?.project ?? defaults.project,
    threadName: context.threadName ?? origin?.thread ?? defaults.threadName,
  };
  const usable = (value, placeholders) => typeof value === "string" && value.trim() !== ""
    && !(placeholders?.has(value.trim().toLowerCase()));
  const checks = [
    ["--source", candidates.providerName, undefined, "<your agent, e.g. Claude Code>"],
    ["--project", candidates.project, PLACEHOLDER_PROJECTS, "<repository or product>"],
    ["--topic", candidates.threadName, PLACEHOLDER_TOPICS, "<what this work is about>"],
  ];
  const problems = checks.filter(([, value, placeholders]) => !usable(value, placeholders));
  if (problems.length > 0) {
    const absent = problems.filter(([, value]) => typeof value !== "string" || value.trim() === "").map(([flag]) => flag);
    const generic = problems.filter(([flag]) => !absent.includes(flag));
    const parts = [
      ...(absent.length > 0 ? [`Missing ${absent.join(", ")}`] : []),
      ...generic.map(([flag, value]) => `${flag} ${shellQuote(value.trim())} is too generic`),
    ];
    const needsTopic = problems.some(([flag]) => flag === "--topic");
    // Only the flags still needed, as one command to copy: an agent fixes it in a single retry.
    const flags = problems.map(([flag, , , placeholder]) => `${flag} ${shellQuote(placeholder)}`).join(" ");
    throw new UsageError(
      `${parts.join("; ")}${needsTopic ? ': name the work the way the owner would (e.g. "Release 0.7.57").' : "."}`,
      {
        missing: problems.map(([flag]) => flag.slice(2)),
        hint: example ? `${example} ${flags}` : `Add ${flags}`,
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

function stdinContext(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError("stdin context must be an object");
  }
  return value;
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/**
 * One card per piece of work. `owner` is the caller's own card (its type's message port says: an agent session,
 * or a script's RELO_SESSION): every command lands on it (the key format predates sessionKey() and is kept so
 * running cards survive an upgrade); without one the card is identified by source › project › topic. --name
 * overrides both.
 */
export function cardKey({ name, context, env, owner }) {
  // With an encryption identity the key is keyed, so the server cannot test guesses of names (E2.5).
  const identity = name !== undefined || !owner ? loadIdentitySync(env ?? process.env) : null;
  const keyed = (value) => (identity
    ? createHmac("sha256", subkey(identity, "card-keys")).update(value).digest("hex").slice(0, 24) : shortHash(value));
  if (name !== undefined) return identity ? `name-${keyed(name)}` : name;
  if (owner) return `session-${owner.label}-${shortHash(owner.id)}`;
  if (!context?.providerName || !context?.project || !context?.threadName) return undefined;
  return `work-${keyed([context.providerName, context.project, context.threadName].join("\u0000"))}`;
}

export function partialIdentity(options, stdin, defaults) {
  const context = stdinContext(stdin.context) ?? {};
  return {
    providerName: options.source ?? context.providerName ?? defaults.providerName,
    project: options.project ?? context.project ?? defaults.project,
    threadName: options.topic ?? options["thread-name"] ?? context.threadName ?? defaults.threadName,
  };
}
