import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { loadIdentitySync, subkey } from "./keystore.mjs";
import { existsSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { requireText } from "./args.mjs";
import { UsageError } from "./errors.mjs";
import { definedFields, enumOption, optionalText, shellQuote } from "./support.mjs";
import { cardOwner, detectAgent, detectCaller, waitsShort } from "./caller.mjs";

export { detectAgent } from "./caller.mjs";

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

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** True when an agent harness (or a RELO_SESSION) is running this command: its shell tool kills long commands. */
export function inAgentContext(env = process.env) {
  return waitsShort(detectCaller(env));
}

function cleanLabel(value, maximum) {
  const label = String(value ?? "").replace(/[\u0000-\u001F\u007F]/gu, " ").trim();
  return label ? Array.from(label).slice(0, maximum).join("").trim() || undefined : undefined;
}

/**
 * The name of this computer: RELO_COMPUTER, else the macOS ComputerName ("Studio MacBook Pro"),
 * else the hostname without its domain. Probes are injectable for tests.
 */
export function detectComputerName(env = process.env, probes = {}) {
  const fromEnv = cleanLabel(env.RELO_COMPUTER, 120);
  if (fromEnv) return fromEnv;
  if ((probes.platform ?? process.platform) === "darwin") {
    try {
      const scutil = probes.scutil
        ?? (() => execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"] }));
      const name = cleanLabel(scutil(), 120);
      if (name) return name;
    } catch {
      // Fall through to the hostname.
    }
  }
  try {
    const host = String((probes.hostname ?? osHostname)() ?? "").trim();
    return cleanLabel(host.split(".")[0], 120);
  } catch {
    return undefined;
  }
}

/** The config directory of the calling agent, and whether the environment moved it off the default. */
function agentConfigDirectory(agent, env, home) {
  const [variable, fallback] = agent === "Claude Code" ? ["CLAUDE_CONFIG_DIR", ".claude"]
    : agent === "Codex" ? ["CODEX_HOME", ".codex"] : [];
  if (variable !== undefined) {
    const standard = resolvePath(join(home, fallback));
    const configured = text(env[variable]);
    const directory = configured === undefined ? standard : resolvePath(configured);
    return { directory, key: directory, custom: directory !== standard };
  }
  // Any other harness: no config folder is known, so a nickname is keyed by the harness name.
  const name = agent ?? text(env.RELO_SOURCE);
  return name === undefined ? undefined : { directory: undefined, key: `harness:${name.toLowerCase().slice(0, 80)}`, custom: false };
}

/** A nickname from a custom config directory name: ~/.claude-work becomes "work". */
function accountFromDirectory(directory) {
  const name = basename(directory).replace(/^\./u, "").replace(/^(claude|codex)[-_]/iu, "");
  return name && !/^(claude|codex)$/iu.test(name) ? cleanLabel(name, 40) : undefined;
}

/**
 * Which agent account is this? RELO_ACCOUNT, else a nickname from `relo account NAME`, else the name
 * of a custom CLAUDE_CONFIG_DIR / CODEX_HOME. Only directory names and Relo's own config are read.
 */
export function detectAccount(env = process.env, probes = {}) {
  const agent = detectAgent(env);
  const where = agentConfigDirectory(agent, env, probes.home ?? homedir());
  const configDirectory = where?.directory;
  const accountKey = where?.key;
  const fromEnv = cleanLabel(env.RELO_ACCOUNT, 40);
  if (fromEnv) return { account: fromEnv, via: "RELO_ACCOUNT", agent, configDirectory, accountKey };
  if (where === undefined) return { account: undefined, agent, configDirectory, accountKey };
  const stored = cleanLabel((probes.accounts?.() ?? {})[where.key], 40);
  if (stored) return { account: stored, via: "nickname", agent, configDirectory, accountKey };
  const derived = where.custom ? accountFromDirectory(where.directory) : undefined;
  return { account: derived, ...(derived ? { via: "directory" } : {}), agent, configDirectory, accountKey };
}

/**
 * Identity an agent should not have to repeat: RELO_SOURCE/RELO_PROJECT/RELO_TOPIC, then the
 * calling agent recognized from its environment and the git repository it runs in. The topic is
 * never guessed: only the caller knows what the work is about.
 */
export function detectIdentityDefaults(env = process.env, cwd = process.cwd(), exists = existsSync) {
  let repository;
  try { repository = repositoryName(cwd, exists); } catch { repository = undefined; }
  return definedFields({
    providerName: text(env.RELO_SOURCE) ?? detectAgent(env),
    project: text(env.RELO_PROJECT) ?? repository,
    threadName: text(env.RELO_TOPIC),
  });
}

/** Where a card came from: this computer and agent account. Only creations need it. */
export function detectOrigin(env = process.env, probes = {}) {
  return definedFields({ computer: detectComputerName(env, probes), account: detectAccount(env, probes).account });
}

/** `example` is the command being run, e.g. `relo activity start --title "x"`, so the hint can finish it. */
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

export function stdinContext(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError("stdin context must be an object");
  }
  return value;
}

/**
 * Compatibility view of the typed caller (src/caller.mjs): the owner of the caller's own card as
 * { agent, id }, or null for an unidentified caller or a keyless script. New code uses dependencies.caller.
 */
export function agentSession(env = process.env) {
  const owner = cardOwner(detectCaller(env));
  return owner ? { agent: owner.label, id: owner.id } : null;
}

export function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/**
 * One card per piece of work. Inside an identified session every command lands on that session's
 * card (the key format predates sessionKey() and is kept so running cards survive an upgrade); elsewhere the card is identified by source › project › topic. --name overrides both.
 */
export function cardKey({ name, context, env, caller }) {
  const owner = cardOwner(caller ?? detectCaller(env ?? process.env));
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
