// Every harness Relo knows, from one descriptor each (harness/adapters/<id>/descriptor.mjs). Detection,
// labels, session variables, config folders and the files setup writes are all derived here, so a harness
// fact lives in exactly one place and adding a harness is adding its descriptor (ADR 0008 principle 12).
import { statSync } from "node:fs";
import agents from "./adapters/agents/descriptor.mjs";
import amp from "./adapters/amp/descriptor.mjs";
import antigravity from "./adapters/antigravity/descriptor.mjs";
import claudeCode from "./adapters/claude-code/descriptor.mjs";
import claudeDesktop from "./adapters/claude-desktop/descriptor.mjs";
import codex from "./adapters/codex/descriptor.mjs";
import copilot from "./adapters/copilot/descriptor.mjs";
import cursor from "./adapters/cursor/descriptor.mjs";
import gemini from "./adapters/gemini/descriptor.mjs";
import mcp from "./adapters/mcp/descriptor.mjs";
import opencode from "./adapters/opencode/descriptor.mjs";
import vscode from "./adapters/vscode/descriptor.mjs";
import { configDirectory } from "./paths.mjs";

/** In detection order: the first whose markers are in the environment is the calling harness. */
export const HARNESSES = Object.freeze([claudeCode, codex, opencode, antigravity, gemini, cursor, copilot, amp, claudeDesktop, vscode, agents, mcp]);

/** The harness for an id or alias (case-insensitive), or undefined. */
export function harnessFor(name) {
  const wanted = String(name ?? "").trim().toLowerCase();
  return HARNESSES.find((harness) => harness.id === wanted || harness.aliases.includes(wanted));
}

/** The display name for a harness id: "claude-code" → "Claude Code"; an unknown id stays as given. */
export const harnessLabel = (id) => harnessFor(id)?.label ?? id;

/** The harness running this command, from the markers it sets in its agent's shell; undefined outside one. */
export const detectHarness = (env) => HARNESSES.find((harness) => harness.detect?.(env));

/** The cloud sandbox this command runs in (a harness's ephemeral marker, e.g. Claude Code on the web), or undefined. */
export const ephemeralEnvironment = (env) => HARNESSES.find((harness) => harness.ephemeral?.detect(env))?.ephemeral;

/** [[harness id, variable]] for the harnesses that expose their session id to the agent's shell. */
export const SESSION_VARIABLES = Object.freeze(HARNESSES.filter((harness) => harness.sessionVariable).map((harness) => [harness.id, harness.sessionVariable]));

const isDirectory = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };

/** The harnesses whose config folder exists on this computer (installed, or once used). */
export function presentHarnesses(probe) {
  return HARNESSES.filter((harness) => {
    const folder = configDirectory(harness, probe)?.directory;
    return folder !== undefined && isDirectory(folder);
  });
}
