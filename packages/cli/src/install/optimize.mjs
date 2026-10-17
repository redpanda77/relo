// Optimize's extras (plan 12 §4.6, §4.7) as plan items: the status line wrapper, the named subagent definitions and,
// only when asked, the subagent model default. Each touches only Relo's part of a file and leaves a way back:
//  - statusLine in the harness's settings file becomes `relo statusline`; the owner's previous one is saved in Relo's
//    own state (hooks/optimize.json, never in the settings file) and put back exactly by uninstall or a shallower depth;
//  - agents are files in the harness's agents folder that carry Relo's marker; a same-named file without it is never
//    touched;
//  - CLAUDE_CODE_SUBAGENT_MODEL in the settings `env` is recorded when Relo sets it, so only Relo's value is removed.
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { STATUSLINE_COMMAND, optimizeStatePath } from "../harness/core/statusline.mjs";
import { UsageError } from "../shared/errors.mjs";
import { layout, parseSettings, render } from "./hooks.mjs";

export const SUBAGENT_MODEL_VARIABLE = "CLAUDE_CODE_SUBAGENT_MODEL";
const AGENT_MARK = "<!-- relo:managed ";
const TOML_MARK = "# relo:managed ";
/** Agent file formats by harness: Claude Code reads markdown with front matter; Codex reads one TOML file per agent. */
const FORMATS = Object.freeze({ md: { ext: ".md", mark: AGENT_MARK }, toml: { ext: ".toml", mark: TOML_MARK } });
const formatOf = (format) => FORMATS[format] ?? FORMATS.md;

const AGENTS = Object.freeze({
  "relo-explore": `---
name: relo-explore
description: Use for searching and reading the codebase: finding where something is defined, tracing how code flows, summarizing what files do. Fast and cheap; it only reads and never edits.
tools: Read, Grep, Glob
model: haiku
---
${AGENT_MARK}relo-explore v1: written by \`relo setup --level optimize\`, removed by \`relo uninstall\`. Delete this line to keep your own edits. -->

You search and read. Answer the question you were given with file paths and line numbers, quoting only what matters.
Do not edit files. Say plainly what you could not find rather than guessing. Run no relo commands.
`,
  "relo-worker": `---
name: relo-worker
description: Use to implement a well-specified change: the files, the behavior and the checks are named in the request. A mid-size model for the doing; not for open-ended design or review.
model: sonnet
---
${AGENT_MARK}relo-worker v1: written by \`relo setup --level optimize\`, removed by \`relo uninstall\`. Delete this line to keep your own edits. -->

You implement the change you were given, exactly as specified, and nothing beyond it.
Run the checks the request names. Report which files you changed and what the checks showed; if the request
cannot be done as written, stop and say why instead of improvising. Run no relo commands: the agent that
started you keeps the Relo work.
`,
});

// Codex custom agents (developers.openai.com/codex/subagents → learn.chatgpt.com/docs/agent-configuration/subagents):
// ~/.codex/agents/<name>.toml, one agent per file, required name, description and developer_instructions, optional
// model and model_reasoning_effort. sandbox_mode in an agent file is ignored by Codex, so the explorer is read-only
// by its instructions. No model is named: Codex's model names change often, and a wrong one would break the
// agent, so each inherits the session's model and differs by reasoning effort (low to explore, medium to build).
const CODEX_AGENTS = Object.freeze({
  "relo-explore": `${TOML_MARK}relo-explore v1: written by \`relo setup --level optimize\`, removed by \`relo uninstall\`. Delete this line to keep your own edits.
name = "relo-explore"
description = "Use for searching and reading the codebase: finding where something is defined, tracing how code flows, summarizing what files do. Quick, with low reasoning effort; it only reads and never edits."
model_reasoning_effort = "low"
developer_instructions = """
You search and read. Answer the question you were given with file paths and line numbers, quoting only what matters.
Do not edit files. Say plainly what you could not find rather than guessing. Run no relo commands.
"""
`,
  "relo-worker": `${TOML_MARK}relo-worker v1: written by \`relo setup --level optimize\`, removed by \`relo uninstall\`. Delete this line to keep your own edits.
name = "relo-worker"
description = "Use to implement a well-specified change: the files, the behavior and the checks are named in the request. Medium reasoning effort for the doing; not for open-ended design or review."
model_reasoning_effort = "medium"
developer_instructions = """
You implement the change you were given, exactly as specified, and nothing beyond it.
Run the checks the request names. Report which files you changed and what the checks showed; if the request
cannot be done as written, stop and say why instead of improvising. Run no relo commands: the agent that
started you keeps the Relo work.
"""
`,
});
const TEXTS = Object.freeze({ md: AGENTS, toml: CODEX_AGENTS });
export const AGENT_NAMES = Object.freeze(Object.keys(AGENTS));

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const readIfPresent = async (path) => { try { return await readFile(path, "utf8"); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; } };

async function readState(path) {
  try { const value = JSON.parse(await readFile(path, "utf8")); return isObject(value) ? value : {}; } catch { return {}; }
}
async function writeState(path, state) {
  const { v, ...rest } = state;
  if (Object.keys(rest).length === 0) { await rm(path, { force: true }); return; }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ v: 1, ...rest }), { mode: 0o600 });
}

/** The status readings of every session (written by relo statusline) go with the wrapper. */
async function clearReadings(directory) {
  for (const name of await readdir(directory).catch(() => [])) if (/^context-.*\.json(\..*)?$/u.test(name)) await rm(join(directory, name), { force: true });
}

/** Reads a settings file, hands the object to `change`, writes the result unless dry; `change` returns the report row. */
async function editSettings(path, dryRun, change) {
  const current = await readIfPresent(path);
  const settings = current === undefined || current.trim() === "" ? {} : parseSettings(path, current);
  const form = current === undefined ? { indent: "  ", eol: "\n", final: "\n", bom: "" } : layout(current);
  const before = JSON.stringify(settings);
  const { removeEmpty, ...row } = await change(settings, { created: current === undefined, commit: !dryRun }) ?? {};
  if (JSON.stringify(settings) === before) return row.action ? row : { action: "unchanged" };
  if (!dryRun) {
    if (Object.keys(settings).length === 0 && removeEmpty) await rm(path);
    else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, render(settings, form)); }
  }
  return row.action ? row : { action: "updated" };
}

/** Puts `relo statusline` in; the owner's previous status line goes to Relo's state first. */
export function statusLineItem(harness, settingsPath, directory, { remove = false } = {}) {
  const statePath = optimizeStatePath(directory);
  return {
    kind: "statusline", harness, path: settingsPath,
    apply: (dryRun) => editSettings(settingsPath, dryRun, async (settings, { created, commit }) => {
      const state = await readState(statePath);
      const ours = settings.statusLine?.command === STATUSLINE_COMMAND;
      if (!remove) {
        if (ours) return { action: "unchanged" };
        const previous = settings.statusLine === undefined ? null : settings.statusLine;
        settings.statusLine = { ...(isObject(previous) ? previous : {}), type: "command", command: STATUSLINE_COMMAND };
        if (commit) await writeState(statePath, { ...state, statusLine: { previous } });
        return { action: created ? "created" : "updated" };
      }
      const saved = state.statusLine;
      if (commit) {
        if (saved) { delete state.statusLine; await writeState(statePath, state); }
        await clearReadings(directory);
      }
      if (!ours) return { action: "unchanged" };
      if (isObject(saved?.previous)) settings.statusLine = saved.previous; else delete settings.statusLine;
      return { action: "removed", removeEmpty: true };
    }),
  };
}

/** CLAUDE_CODE_SUBAGENT_MODEL in the settings env: set to `value`, or (remove) taken out when Relo's value is still there. */
export function subagentModelItem(harness, settingsPath, directory, { value, remove = false } = {}) {
  const statePath = optimizeStatePath(directory);
  return {
    kind: "subagent-model", harness, path: settingsPath,
    apply: (dryRun) => editSettings(settingsPath, dryRun, async (settings, { commit }) => {
      const state = await readState(statePath);
      if (settings.env !== undefined && !isObject(settings.env)) throw new UsageError(`${settingsPath}: "env" must be an object.`);
      const now = settings.env?.[SUBAGENT_MODEL_VARIABLE];
      const mine = state.subagentModel;
      if (!remove) {
        if (now === value) return { action: "unchanged" };
        const createdEnv = mine ? mine.createdEnv : settings.env === undefined;
        settings.env = { ...(settings.env ?? {}), [SUBAGENT_MODEL_VARIABLE]: value };
        if (commit) await writeState(statePath, { ...state, subagentModel: { previous: mine ? mine.previous : (now ?? null), value, createdEnv } });
        return { action: now === undefined ? "added" : "updated", level: value };
      }
      if (commit && mine) { delete state.subagentModel; await writeState(statePath, state); }
      if (!mine || now !== mine.value) return { action: "unchanged" };
      if (typeof mine.previous === "string") settings.env = { ...settings.env, [SUBAGENT_MODEL_VARIABLE]: mine.previous };
      else {
        const { [SUBAGENT_MODEL_VARIABLE]: _taken, ...rest } = settings.env;
        if (Object.keys(rest).length === 0 && mine.createdEnv) delete settings.env; else settings.env = rest;
      }
      return { action: "removed" };
    }),
  };
}

/** A subagent definition file in the harness's agents folder. A file Relo did not write is never replaced or removed. */
export function agentItem(harness, path, name, { remove = false, format = "md" } = {}) {
  const { ext, mark } = formatOf(format);
  return {
    kind: "agent", harness, path,
    apply: async (dryRun) => {
      const wanted = TEXTS[format][name];
      const current = await readIfPresent(path);
      const managed = current?.includes(mark) === true;
      if (remove) {
        if (current === undefined || !managed) return { action: "unchanged" };
        if (!dryRun) await rm(path);
        return { action: "removed" };
      }
      if (current !== undefined && !managed) return { action: "kept", reason: `${name}${ext} is yours (it has no Relo marker): Relo leaves it` };
      if (current === wanted) return { action: "unchanged" };
      if (!dryRun) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, wanted); }
      return { action: current === undefined ? "created" : "updated" };
    },
  };
}

/** Relo's agent files that exist in a folder (the ones carrying the marker), for uninstall and refresh. */
export function managedAgentFiles(folder, format = "md") {
  const { ext, mark } = formatOf(format);
  try {
    return readdirSync(folder).filter((file) => file.endsWith(ext) && AGENTS[file.slice(0, -ext.length)])
      .filter((file) => readFileSync(join(folder, file), "utf8").includes(mark)).map((file) => ({ name: file.slice(0, -ext.length), path: join(folder, file) }));
  } catch { return []; }
}

/** Whether a settings file's status line is Relo's wrapper (read only). */
export function ownsStatusLine(settingsPath) {
  try { return JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/u, ""))?.statusLine?.command === STATUSLINE_COMMAND; } catch { return false; }
}

/** What Relo recorded it changed (status line, subagent model), for the shallower depths and uninstall. */
export function recordedExtras(directory) {
  try {
    const state = JSON.parse(readFileSync(optimizeStatePath(directory), "utf8"));
    return { statusLine: Boolean(state?.statusLine), subagentModel: Boolean(state?.subagentModel) };
  } catch { return { statusLine: false, subagentModel: false }; }
}

/** `--subagent-model`: a model alias or id as Claude Code takes it (haiku, sonnet, opus, a full model id), or `off`. */
export function checkSubagentModel(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,79}$/u.test(text)) {
    throw new UsageError(`--subagent-model takes a model such as haiku, sonnet or opus, or off; got "${text}".`);
  }
  return text;
}
