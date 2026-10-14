import { hookLabelsWithNames } from "../opaque-names.mjs";
import { sealSessionNames } from "../seal-notice.mjs";
// `relo hook <event>`: the one entry point for agent-harness hooks (installed by `relo setup --hooks`).
// It reports THAT a session started, is working, stopped or ended, on its own channel, never what the
// agent did. From the harness's hook JSON (stdin) it keeps the session id, the event name and the cwd
// (only to name the git project); prompts, tool input/output and transcript paths are dropped unread.
// It prints nothing (Claude Code injects hook stdout into the model's context), never fails, and
// the caller exits 0 whatever happens. RELO_DEBUG=1 writes errors to a debug log in Relo's state folder.
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertAllowedOptions, definedFields, result } from "../support.mjs";
import { agentSession, cardKey, detectAccount, detectAgent, repositoryName } from "../identity.mjs";

export const HOOK_EVENTS = ["start", "prompt", "tool", "stop", "wait", "end"];

/**
 * Claude Code Notification types that mean the session is blocked on the owner (a permission or an
 * input prompt). Others (idle_prompt a minute after a turn, auth_success, …) are not sent.
 */
export const WAITING_NOTIFICATIONS = ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"];

/**
 * Harnesses with documented hook events, and how their event names map to Relo's.
 *  - Claude Code: code.claude.com/docs/en/hooks. Settings `hooks.<Event>[].hooks[]`, stdin JSON with session_id,
 *    cwd, hook_event_name, transcript_path; notification_type on Notification; agent_id inside a subagent, which
 *    shares its parent's session_id, so a subagent is never a session of its own.
 *  - Gemini CLI: geminicli.com/docs/hooks. Same settings shape (`hooks.<Event>[].hooks[]`, timeout in ms), same
 *    base stdin fields. Its shell carries no session id, so its cards are not linked unless RELO_SESSION is set.
 */
export const HOOK_HARNESSES = {
  "claude-code": { label: "Claude Code", events: {
    SessionStart: "start", UserPromptSubmit: "prompt", PostToolUse: "tool", Stop: "stop", Notification: "wait", SessionEnd: "end" },
  matchers: { Notification: WAITING_NOTIFICATIONS.join("|") },
  linksCard: true },
  gemini: { label: "Gemini CLI", events: {
    SessionStart: "start", BeforeAgent: "prompt", AfterTool: "tool", AfterAgent: "stop", SessionEnd: "end" },
  linksCard: false },
};

export const TOOL_COALESCE_MS = 60_000;
const STDIN_TIMEOUT_MS = 1_500;
const SEND_BUDGET_MS = 2_500;
const SEND_RETRY_WITHIN_MS = 500;
const SEND_RETRY_PAUSE_MS = 100;

const sessionHash = (harness, id) => createHash("sha256").update(`${harness}:${id}`).digest("base64url");
const label = (value, maximum) => {
  const text = Array.from(String(value ?? "").replace(/[\u0000-\u001F\u007F]/gu, " ").trim()).slice(0, maximum).join("").trim();
  return text || undefined;
};

async function readInput(dependencies) {
  if (dependencies.stdinIsTTY) return {};
  const timer = {};
  const timeout = new Promise((resolve) => { timer.id = setTimeout(() => resolve({}), STDIN_TIMEOUT_MS); timer.id.unref?.(); });
  try {
    const value = await Promise.race([dependencies.readStdinJson(), timeout]);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } finally {
    clearTimeout(timer.id);
  }
}

const stateFile = (directory, prefix, session) => join(directory, `${prefix}-${session.slice(0, 24)}`);
const readStamp = async (file) => {
  try { const value = Number(await readFile(file, "utf8")); return Number.isFinite(value) ? value : undefined; } catch { return undefined; }
};

/**
 * True when a tool event for this session was sent within the last minute and nothing has reset the window
 * since. Any other event (start, prompt, stop, end) resets it, so the first tool event after a Stop always goes
 * out and turns an idle session active again (background subagents keep working after the main turn ends).
 */
async function coalesced(directory, session, now) {
  const last = await readStamp(stateFile(directory, "tool", session));
  if (last === undefined || now - last >= TOOL_COALESCE_MS || now < last) return false;
  const reset = await readStamp(stateFile(directory, "reset", session));
  return !(reset !== undefined && reset >= last);
}

/** Records a tool event only once the server took it, so a failed send never suppresses the next minute. */
async function recordToolSent(directory, session, at) {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(stateFile(directory, "tool", session), String(at), { mode: 0o600 });
  } catch { /* best effort */ }
}

/**
 * Opens the coalescing window again. A reset stamp (not a delete) so a tool send still in flight from before
 * the Stop, which records its own earlier time, cannot close the window behind it.
 */
async function resetToolWindow(directory, session, at) {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(stateFile(directory, "reset", session), String(at), { mode: 0o600 });
  } catch { /* best effort */ }
}

/**
 * One send, plus one quick retry when the network failed fast (refused, reset, DNS), all inside ~2.5 s so
 * a hook stays well within the harness's 5 s budget. Server answers (4xx/5xx) and timeouts are not retried.
 */
async function send(client, body) {
  const started = performance.now();
  try {
    return await client.sendAgentSessionEvent(body);
  } catch (error) {
    const elapsed = performance.now() - started;
    if (error?.code !== "NETWORK_ERROR" || elapsed > SEND_RETRY_WITHIN_MS) throw error;
    await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_PAUSE_MS));
    const remaining = SEND_BUDGET_MS - (performance.now() - started);
    if (remaining < 250) throw error;
    return client.sendAgentSessionEvent(body, { timeoutMs: Math.min(2_000, Math.floor(remaining)) });
  }
}

/**
 * The session's names sealed for the phones, once per session (again only if they change), so the
 * phone can show "relo" and "MacBook Pro" instead of handles. Returns null when nothing is to be sent.
 */
async function sessionNames(directory, session, names, client, config, dependencies) {
  if (!names || Object.keys(names).length === 0) return null;
  const digest = createHash("sha256").update(JSON.stringify(Object.entries(names).sort())).digest("hex");
  const marker = join(directory, `names-${session.slice(0, 24)}`);
  try {
    if (await readFile(marker, "utf8") === digest) return null;
  } catch { /* not sent yet */ }
  try {
    const envelope = await sealSessionNames({ names, session, client, config: { apiUrl: config.apiUrl }, dependencies });
    if (!envelope) return null;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return { envelope, marker, digest };
  } catch {
    return null;
  }
}

async function computerFor(dependencies, config) {
  const fromEnv = label(dependencies.env.RELO_COMPUTER, 120);
  if (fromEnv) return fromEnv;
  const cached = label(config.computerName ?? dependencies.loadComputerName?.(), 120);
  if (cached) return cached;
  const detected = label(dependencies.computerName?.(), 120);
  // Cached once so later hooks skip the scutil probe. Best effort: a hook never fails over it.
  if (detected && config.source !== "environment") {
    try {
      const path = dependencies.configPath();
      const stored = await dependencies.loadStoredConfig(path);
      await dependencies.writeConfig(path, { ...stored, computerName: detected }, { expectedRevision: stored.revision });
    } catch { /* ignore */ }
  }
  return detected;
}

async function debug(dependencies, message) {
  if (dependencies.env.RELO_DEBUG !== "1") return;
  try {
    await mkdir(dependencies.hookStateDirectory, { recursive: true, mode: 0o700 });
    await appendFile(join(dependencies.hookStateDirectory, "hook-debug.log"),
      `${new Date(dependencies.now()).toISOString()} ${String(message).slice(0, 300)}\n`, { mode: 0o600 });
  } catch { /* nothing more to do */ }
}

/** Handles one hook invocation. Resolves with what was sent (or why not); never rejects. */
export async function processHook({ positionals, options, dependencies }) {
  try {
    const input = await readInput(dependencies);
    const harnessName = options.agent === undefined ? "claude-code" : String(options.agent).toLowerCase();
    const harness = HOOK_HARNESSES[harnessName];
    if (!harness) return { sent: false, reason: "unknown_harness" };
    const named = positionals[1];
    const event = HOOK_EVENTS.includes(named) ? named : harness.events[input.hook_event_name];
    const id = typeof input.session_id === "string" ? input.session_id.trim() : "";
    if (!event || !id || id.length > 500) return { sent: false, reason: "no_session" };
    // Only a prompt that blocks on the owner is a wait (the matcher filters too; older harnesses may not).
    if (event === "wait" && !WAITING_NOTIFICATIONS.includes(input.notification_type)) return { sent: false, reason: "not_waiting" };
    // A subagent's own lifecycle is not the session's: its tool events count toward the parent session.
    if (typeof input.agent_id === "string" && input.agent_id && ["start", "stop", "end"].includes(event)) {
      return { sent: false, reason: "subagent" };
    }
    const session = sessionHash(harnessName, id);
    const now = dependencies.now();
    const stateDirectory = dependencies.hookStateDirectory;
    if (event === "tool" && await coalesced(stateDirectory, session, now)) return { sent: false, reason: "coalesced" };
    if (event === "end") {
      for (const prefix of ["tool", "reset", "names"]) await rm(stateFile(stateDirectory, prefix, session), { force: true }).catch(() => {});
    } else if (event !== "tool") {
      await resetToolWindow(stateDirectory, session, now);
    }

    const config = await dependencies.loadConfig(dependencies.configPath());
    const env = harnessName === "claude-code" && detectAgent(dependencies.env) === undefined
      ? { ...dependencies.env, CLAUDECODE: "1" } : dependencies.env;
    let project = label(dependencies.env.RELO_PROJECT, 120);
    if (!project && typeof input.cwd === "string" && input.cwd) {
      try { project = label(repositoryName(input.cwd), 120); } catch { /* no repository */ }
    }
    // Once this computer seals for a phone, project, computer and account go out as handles (E2.5).
    const plainLabels = { project, computer: await computerFor(dependencies, config),
      account: label(detectAccount(env, dependencies.accountProbes).account, 40) };
    // On any failure send no labels rather than readable ones.
    const { labels, names } = await hookLabelsWithNames(plainLabels, config?.apiUrl, dependencies)
      .catch(() => ({ labels: {}, names: {} }));
    project = labels.project;
    const { computer, account } = labels;
    const client = dependencies.clientFactory(config);
    const sealedNames = event === "end" ? undefined : await sessionNames(stateDirectory, session, names, client, config, dependencies);
    // The card key the activity commands derive for this session, so the server can link card and session.
    const explicit = agentSession(dependencies.env)?.agent === "relo";
    const key = explicit ? cardKey({ env: dependencies.env })
      : harness.linksCard ? cardKey({ env: { CLAUDE_CODE_SESSION_ID: id } }) : undefined;
    const body = definedFields({ session, harness: harnessName, event, at: new Date(now).toISOString(),
      project, computer, account, cardKey: label(key, 100), sealedNames: sealedNames?.envelope });
    await send(client, body);
    if (event === "tool") await recordToolSent(stateDirectory, session, now);
    if (sealedNames) await writeFile(sealedNames.marker, sealedNames.digest, { mode: 0o600 }).catch(() => {});
    return { sent: true, event };
  } catch (error) {
    await debug(dependencies, `hook failed: ${error?.code ?? error?.name ?? "error"}: ${error?.message ?? ""}`);
    return { sent: false, reason: "error" };
  }
}

/** `relo hook EVENT [--agent NAME]`: silent by design; the CLI entry point discards the result. */
export async function runHookCommand(command) {
  const { options, group, positionals, dependencies } = command;
  if (group !== "hook") return undefined;
  assertAllowedOptions(options, ["agent"]);
  const outcome = await processHook({ positionals, options, dependencies });
  return result("hook", outcome);
}
