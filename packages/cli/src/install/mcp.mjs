// `relo setup --mcp`: Relo's MCP server entry in ONE harness config file the owner chooses. The entry is
// named `relo`; running setup again is a no-op and --remove deletes only that entry (every other key, server
// and line of the file stays). Never automatic: doctor only reads these files.
// Where each harness keeps the file and in which format: its descriptor (harness/adapters/<id>/descriptor.mjs,
// sources confirmed 13 October 2026 from the vendors' documentation). A harness without `mcp` there is not offered.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { UsageError } from "../shared/errors.mjs";
import { HARNESSES } from "../harness/catalog.mjs";
import { harnessPath, projectPath } from "../harness/paths.mjs";
import { entryNamesNewerCli } from "./versions.mjs";

const MCP_SERVER_NAME = "relo";
/** A question waits at most 5 minutes (+ margin): hosts whose default tool timeout is shorter must be told. */
const TOOL_TIMEOUT_SECONDS = 330;

const ARGS = ["mcp"];

/** GUI apps do not inherit the shell PATH (and `relo` is a `#!/usr/bin/env node` script): name node and the script. */
function guiEntry({ nodePath, entrypoint }) {
  return { command: nodePath, args: [entrypoint, ...ARGS] };
}
const shellEntry = () => ({ command: "relo", args: [...ARGS] });

/** One target per harness with an MCP config (harness/catalog.mjs): where its file is, and Relo's entry in it. */
function mcpTarget(harness) {
  const { format, key, stdioType, launch, toolTimeout, global, project } = harness.mcp;
  return {
    format, key, gui: launch === "absolute",
    entry: (e) => ({ ...(stdioType ? { type: "stdio" } : {}), ...(launch === "absolute" ? guiEntry(e) : shellEntry(e)),
      ...(toolTimeout ? { tool_timeout_sec: TOOL_TIMEOUT_SECONDS } : {}) }),
    ...(global ? { global: (probe) => harnessPath(harness, global, probe) } : {}),
    ...(project ? { project: (probe) => projectPath(project, probe) } : {}),
  };
}
const MCP_TARGETS = Object.fromEntries(HARNESSES.filter((harness) => harness.mcp).map((harness) => [harness.id, mcpTarget(harness)]));
const MCP_AGENT_NAMES = Object.keys(MCP_TARGETS);

const shortHome = (path, home) => (path && home && path.startsWith(home) ? `~${path.slice(home.length)}` : path);

/** Every config file that may hold a Relo entry: [{ agent, place, path }]. */
function mcpCandidates(probe) {
  const withPlatform = { ...probe, platform: probe.platform ?? process.platform };
  const seen = new Set();
  const found = [];
  for (const agent of MCP_AGENT_NAMES) {
    for (const place of ["global", "project"]) {
      const path = MCP_TARGETS[agent][place]?.(withPlatform);
      if (path === undefined || seen.has(`${agent}\0${path}`)) continue;
      seen.add(`${agent}\0${path}`);
      found.push({ agent, place, path });
    }
  }
  return found;
}

/** The entry to write. GUI harnesses get absolute node and script paths; shell harnesses get plain `relo`. */
export function wantedEntry(agent, { nodePath, entrypoint }) {
  return MCP_TARGETS[agent].entry({ nodePath, entrypoint });
}

/** True for an entry that launches Relo's MCP server, however it was spelled. */
function isReloEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  const command = typeof entry.command === "string" ? entry.command : "";
  return args.at(-1) === "mcp" && (/(^|[\\/])relo(ctl)?(\.mjs)?$/u.test(command) || args.some((arg) => /(^|[\\/])relo\.mjs$/u.test(String(arg))));
}

// ---------------------------------------------------------------- JSON

function layout(text) {
  const indent = text.match(/^([ \t]+)"/mu)?.[1] ?? "  ";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const final = /(\r?\n)\s*$/u.test(text) ? eol : "";
  return { indent, eol, final, bom: text.startsWith("﻿") ? "﻿" : "" };
}

function render(settings, form) {
  const body = JSON.stringify(settings, null, form.indent);
  return form.bom + (form.eol === "\r\n" ? body.replaceAll("\n", "\r\n") : body) + form.final;
}

function parseJson(path, text, key) {
  let settings;
  try {
    settings = JSON.parse(text.replace(/^﻿/u, ""));
  } catch {
    throw new UsageError(`${path} is not plain JSON, so Relo will not edit it.`, { hint: "Fix the file (no comments or trailing commas), then run setup again." });
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new UsageError(`${path} must hold a JSON object.`);
  if (settings[key] !== undefined && (!settings[key] || typeof settings[key] !== "object" || Array.isArray(settings[key]))) {
    throw new UsageError(`${path}: "${key}" must be an object.`);
  }
  return settings;
}

function planJson(path, current, agent, entry, remove) {
  const key = MCP_TARGETS[agent].key;
  if (current === undefined && remove) return { action: "unchanged" };
  const text = current ?? "";
  const form = current === undefined ? { indent: "  ", eol: "\n", final: "\n", bom: "" } : layout(text);
  const settings = current === undefined || text.trim() === "" ? {} : parseJson(path, text, key);
  const existing = settings[key]?.[MCP_SERVER_NAME];
  if (remove) {
    if (existing === undefined) return { action: "unchanged" };
    if (!isReloEntry(existing)) throw new UsageError(`"${MCP_SERVER_NAME}" in ${path} is not Relo's MCP entry, so Relo leaves it alone.`);
    delete settings[key][MCP_SERVER_NAME];
    if (Object.keys(settings[key]).length === 0) delete settings[key];
    return { action: "removed", empty: Object.keys(settings).length === 0, content: render(settings, form) };
  }
  if (existing !== undefined && !isReloEntry(existing)) {
    throw new UsageError(`${path} already has a "${MCP_SERVER_NAME}" MCP server that is not Relo's.`, { hint: "Rename or remove it first." });
  }
  if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(entry)) return { action: "unchanged", entry };
  // The entry names a newer relo than this one: leave it (two relo versions must not overwrite each other).
  if (existing !== undefined && entryNamesNewerCli(existing, entry)) return { action: "unchanged", entry: existing, keptNewer: true };
  settings[key] ??= {};
  settings[key][MCP_SERVER_NAME] = existing === undefined ? entry : { ...existing, ...entry };
  return { action: current === undefined ? "created" : existing === undefined ? "added" : "updated", entry, content: render(settings, form) };
}

// ---------------------------------------------------------------- TOML (Relo's table only, textually)

const TABLE_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:relo|"relo"|'relo')\s*\]\s*(?:#.*)?$/u;
const SUBTABLE_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:relo|"relo"|'relo')\s*\./u;
const ANY_HEADER = /^\s*\[/u;

function tomlLines(text) {
  const lines = [];
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf("\n", from);
    const end = at === -1 ? text.length : at + 1;
    lines.push(text.slice(from, end));
    from = end;
  }
  return lines;
}

const tomlString = (value) => JSON.stringify(value);
const tomlValue = (value) => Array.isArray(value) ? `[${value.map(tomlValue).join(", ")}]` : typeof value === "number" ? String(value) : tomlString(value);

/** Statements of one table body as [{ key, from, to }] (to exclusive), following arrays that span lines. */
function statements(lines, from, to) {
  const found = [];
  let index = from;
  while (index < to) {
    const match = lines[index].match(/^\s*([A-Za-z0-9_-]+)\s*=/u);
    if (!match) { index += 1; continue; }
    let depth = 0;
    let end = index;
    for (; end < to; end += 1) {
      let inString = null;
      const line = end === index ? lines[end].slice(lines[end].indexOf("=") + 1) : lines[end];
      for (let at = 0; at < line.length; at += 1) {
        const character = line[at];
        if (inString) { if (character === "\\" && inString === '"') at += 1; else if (character === inString) inString = null; continue; }
        if (character === '"' || character === "'") inString = character;
        else if (character === "#") break;
        else if (character === "[" || character === "{") depth += 1;
        else if (character === "]" || character === "}") depth -= 1;
      }
      if (depth <= 0) break;
    }
    found.push({ key: match[1], from: index, to: end + 1 });
    index = end + 1;
  }
  return found;
}

function parseStringValue(source) {
  try { return JSON.parse(source.trim()); } catch { return undefined; }
}

function readToml(lines, start, end) {
  const result = {};
  for (const statement of statements(lines, start + 1, end)) {
    const raw = lines.slice(statement.from, statement.to).join("").replace(/^\s*[A-Za-z0-9_-]+\s*=/u, "").replace(/\s+#[^"']*$/u, "").trim();
    if (statement.key === "command") result.command = parseStringValue(raw);
    else if (statement.key === "args") {
      try { result.args = JSON.parse(raw.replace(/,\s*\]/u, "]")); } catch { result.args = undefined; }
    } else if (statement.key === "tool_timeout_sec") result.tool_timeout_sec = Number(raw);
  }
  return result;
}

function tableRange(lines) {
  const start = lines.findIndex((line) => TABLE_HEADER.test(line.replace(/\r?\n$/u, "")));
  if (start === -1) return undefined;
  let end = start + 1;
  while (end < lines.length && !ANY_HEADER.test(lines[end])) end += 1;
  return { start, end };
}

function tomlTable(entry, eol) {
  return [`[mcp_servers.${MCP_SERVER_NAME}]`, `command = ${tomlValue(entry.command)}`, `args = ${tomlValue(entry.args)}`,
    `tool_timeout_sec = ${entry.tool_timeout_sec}`].map((line) => line + eol).join("");
}

function planToml(path, current, agent, entry, remove) {
  if (current === undefined && remove) return { action: "unchanged" };
  const text = current ?? "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = tomlLines(text);
  const range = tableRange(lines);
  if (range === undefined && (lines.some((line) => /^\s*mcp_servers\s*\.\s*(?:relo|"relo")\b/u.test(line)) || lines.some((line) => /^\s*relo\s*=\s*\{/u.test(line)))
    || lines.some((line) => SUBTABLE_HEADER.test(line.replace(/\r?\n$/u, "")))) {
    throw new UsageError(`${path} defines "relo" in a form Relo will not edit (dotted keys, inline table or sub-tables).`, { hint: "Edit it by hand, or move it to a plain [mcp_servers.relo] table." });
  }
  if (remove) {
    if (range === undefined) return { action: "unchanged" };
    const body = readToml(lines, range.start, range.end);
    if (!isReloEntry(body)) throw new UsageError(`[mcp_servers.relo] in ${path} is not Relo's MCP entry, so Relo leaves it alone.`);
    // At the end of the file setup added one separating blank line before the table: take it too.
    // Mid-file the table's own trailing blank lines go and the blank line before it stays.
    const atEnd = range.end >= lines.length;
    const from = atEnd && range.start > 0 && lines[range.start - 1].trim() === "" ? range.start - 1 : range.start;
    const kept = [...lines.slice(0, from), ...lines.slice(range.end)].join("");
    return { action: "removed", empty: kept.trim() === "", content: kept };
  }
  if (range === undefined) {
    const lead = text === "" ? "" : (text.endsWith("\n") ? "" : eol) + eol;
    return { action: current === undefined ? "created" : "added", entry, content: text + lead + tomlTable(entry, eol) };
  }
  const body = readToml(lines, range.start, range.end);
  if (!isReloEntry(body)) throw new UsageError(`${path} already has a [mcp_servers.relo] table that is not Relo's.`, { hint: "Rename or remove it first." });
  // Rewrite only Relo's own keys in place; anything else the owner added to the table stays.
  if (entryNamesNewerCli(body, entry)) return { action: "unchanged", entry: body, keptNewer: true };
  const wanted = { command: tomlValue(entry.command), args: tomlValue(entry.args), tool_timeout_sec: tomlValue(entry.tool_timeout_sec) };
  const next = lines.slice();
  const current_ = readToml(lines, range.start, range.end);
  let changed = false;
  const stated = statements(lines, range.start + 1, range.end);
  // command and args are always refreshed; the timeout is only added when absent (the owner may have raised it).
  const edits = [];
  for (const key of ["command", "args"]) {
    const statement = stated.find((candidate) => candidate.key === key);
    const same = key === "command" ? current_.command === entry.command : JSON.stringify(current_.args) === JSON.stringify(entry.args);
    if (same) continue;
    changed = true;
    edits.push({ at: statement?.from ?? range.start + 1, count: statement ? statement.to - statement.from : 0, line: `${key} = ${wanted[key]}${eol}` });
  }
  if (!stated.some((candidate) => candidate.key === "tool_timeout_sec")) {
    changed = true;
    edits.push({ at: range.end, count: 0, line: `tool_timeout_sec = ${wanted.tool_timeout_sec}${eol}`, trailing: true });
  }
  if (!changed) return { action: "unchanged", entry };
  for (const edit of edits.sort((a, b) => b.at - a.at)) {
    let at = edit.at;
    if (edit.trailing) { while (at > range.start + 1 && next[at - 1].trim() === "") at -= 1; if (next[at - 1] && !next[at - 1].endsWith("\n")) next[at - 1] += eol; }
    next.splice(at, edit.count, edit.line);
  }
  return { action: "updated", entry, content: next.join("") };
}

// ---------------------------------------------------------------- shared

async function readIfPresent(path) {
  try { return await readFile(path, "utf8"); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

function planMcp(path, current, agent, entry, { remove = false } = {}) {
  return MCP_TARGETS[agent].format === "toml" ? planToml(path, current, agent, entry, remove) : planJson(path, current, agent, entry, remove);
}

export async function planMcpFile(path, agent, entry, options) {
  const current = await readIfPresent(path);
  return { path, agent, current, plan: planMcp(path, current, agent, entry, options) };
}

export async function commitMcp({ path, plan }, { makeDirectory = false } = {}) {
  if (plan.content === undefined) return;
  if (plan.action === "removed" && plan.empty) { await rm(path); return; }
  if (makeDirectory) await mkdir(dirname(path), { recursive: true });
  await writeFile(path, plan.content);
}

/** Files that hold a Relo MCP entry right now: [{ agent, place, path }]. Reads only; unreadable files are skipped. */
export function findMcp(probe) {
  const found = [];
  for (const candidate of mcpCandidates(probe)) {
    let text;
    try { text = readFileSync(candidate.path, "utf8"); } catch { continue; }
    try {
      if (MCP_TARGETS[candidate.agent].format === "toml") {
        const lines = tomlLines(text);
        const range = tableRange(lines);
        const entry = range ? readToml(lines, range.start, range.end) : undefined;
        if (isReloEntry(entry)) found.push({ ...candidate, entry });
      } else {
        const entry = JSON.parse(text.replace(/^﻿/u, ""))?.[MCP_TARGETS[candidate.agent].key]?.[MCP_SERVER_NAME];
        if (isReloEntry(entry)) found.push({ ...candidate, entry });
      }
    } catch { /* not plain JSON or TOML we can read */ }
  }
  return found;
}
