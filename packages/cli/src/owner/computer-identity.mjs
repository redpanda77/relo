// The computer's name and icon in `relo setup` (ADR 0011, plan 11 phase 5): appearance the owner picks once, kept by
// the server for the phone and the Dashboard. `--computer NAME --icon ICON` set them for any caller; a person at a
// terminal who has never been asked is asked once; an agent, a script, `--json` and `--dry-run` never prompt.
// Owner type module: a hook never reaches it (reachability.test.mjs).
import { CALLER_TYPES } from "../caller.mjs";
import { UsageError } from "../shared/errors.mjs";
import { COMPUTER_ICONS } from "../shared/computers.generated.mjs";
import { cleanLabel } from "../shared/label.mjs";
import { readStateFile, statePath, writeStateFile } from "../work/state-file.mjs";
import { computerItem, computerSkipped } from "../install/plan.mjs";
import { machineKind } from "./machine-report.mjs";

const ASKED_FILE = "computer-identity.json";
const NAME_MAX = 80;
const SIGN_IN = "Sign in with relo auth login to name this computer on your phone.";
const KEPT = "appearance on your phone: relo uninstall keeps it";

/** { name?, icon? } from --computer and --icon, refused when they cannot be what the server accepts. */
export function identityFlags(options) {
  const name = typeof options.computer === "string" ? cleanLabel(options.computer, NAME_MAX * 4) : undefined;
  if (typeof options.computer === "string" && !name) throw new UsageError("--computer needs a name.");
  if (name && Array.from(name).length > NAME_MAX) throw new UsageError(`--computer is at most ${NAME_MAX} characters.`);
  if (options.icon !== undefined && !COMPUTER_ICONS.includes(options.icon)) {
    throw new UsageError(`Unknown icon "${options.icon}".`, { hint: `Icons: ${COMPUTER_ICONS.join(", ")}` });
  }
  return { ...(name ? { name } : {}), ...(options.icon ? { icon: options.icon } : {}) };
}

/** A signed-in browser login's config (an environment credential is a pipeline, not a computer), or undefined. */
async function loginConfig(dependencies) {
  try {
    const config = await dependencies.loadConfig(dependencies.configPath());
    return config && config.source !== "environment" ? config : undefined;
  } catch {
    return undefined;
  }
}

/** The asked-once marker lives in the state folder; unreadable means not asked. */
const wasAsked = async (dependencies) => Boolean((await readStateFile(statePath(dependencies, ASKED_FILE)).catch(() => undefined))?.asked);
const markAsked = (dependencies) => writeStateFile(statePath(dependencies, ASKED_FILE), { asked: true }).catch(() => {});

/** The terminal question for the name (the default is what cards already call this computer) and the icon. */
async function askIdentity(dependencies) {
  const suggestedName = (() => { try { return cleanLabel(dependencies.computerName?.(), NAME_MAX); } catch { return undefined; } })();
  const suggestedIcon = machineKind(dependencies.env) ?? "laptop";
  const name = cleanLabel(await dependencies.ask(`What should Relo call this computer?${suggestedName ? ` [${suggestedName}] ` : " "}`, suggestedName), NAME_MAX);
  let icon;
  for (let attempt = 0; attempt < 3 && !icon; attempt += 1) {
    const answer = String(await dependencies.ask(`Icon: ${COMPUTER_ICONS.join(", ")} [${suggestedIcon}] `, suggestedIcon)).toLowerCase();
    if (COMPUTER_ICONS.includes(answer)) icon = answer;
  }
  return { ...(name ? { name } : {}), icon: icon ?? suggestedIcon };
}

/** Sends the choice, then keeps the name as this computer's local name for cards. */
async function send(change, config, dependencies) {
  await dependencies.clientFactory(config).putComputerSelf(change, dependencies.generateIdempotencyKey());
  await markAsked(dependencies);
  if (!change.name) return;
  try {
    const path = dependencies.configPath();
    const stored = await dependencies.loadStoredConfig(path);
    await dependencies.writeConfig(path, { ...stored, computerName: change.name }, { expectedRevision: stored.revision });
  } catch { /* the name is on the server; the local copy is a cache */ }
}

/** A person at their own terminal: a script caller (no harness) with a TTY on both ends, and no --json. */
export const atTerminal = ({ options, dependencies }) =>
  dependencies.caller?.type === CALLER_TYPES.SCRIPT && Boolean(dependencies.stdinIsTTY) && Boolean(dependencies.stdoutIsTTY) && !options.json;

/**
 * The plan item for the name and icon, or undefined when there is nothing to do: no flags and no one to ask.
 * Flags go to any caller. The question is for the owner's own terminal only (a script caller with no harness, a
 * TTY on both ends), never with --json or --dry-run, and only until it has been answered once.
 */
export async function computerIdentityItem({ options, dependencies, dryRun }) {
  const flags = identityFlags(options);
  const flagged = Object.keys(flags).length > 0;
  const asking = !flagged && atTerminal({ options, dependencies }) && !dryRun && !(await wasAsked(dependencies));
  if (!flagged && !asking) return undefined;
  const config = await loginConfig(dependencies);
  if (!config) return computerSkipped(SIGN_IN);
  const change = asking ? await askIdentity(dependencies) : flags;
  const summary = [change.name, change.icon].filter(Boolean).join(", ");
  return computerItem(async (isDryRun) => {
    if (!isDryRun) await send(change, config, dependencies);
    return { action: "updated", reason: `${summary} (${KEPT})` };
  });
}
