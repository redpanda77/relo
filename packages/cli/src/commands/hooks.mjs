// `relo hooks status [--json]` and `relo hooks off` (plan 05 §3.1). Status only reads; off deletes Relo's
// hook entries from every settings file that holds them (others' hooks untouched), revokes this
// computer's harness credential and drops observed snapshots still queued.
import { UsageError } from "../errors.mjs";
import { ADAPTERS } from "../harness/adapters/index.mjs";
import { readHarnessCredential, revokeHarnessCredential } from "../harness/core/credential.mjs";
import { inferLevel } from "../harness/core/install.mjs";
import { commitLevel, findHooks, planLevelFile } from "../hooks-settings.mjs";
import { discard, pending } from "../outbox/index.mjs";
import { assertAllowedOptions, assertNoExtra, result } from "../support.mjs";

const USAGE = "Usage: relo hooks status | relo hooks off";
const shown = (path, home) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path);

export async function hooksStatus({ env, home, cwd }, dependencies) {
  const files = findHooks({ env, home, cwd }).map((found) => {
    const { level, outdated } = inferLevel(found.settings, ADAPTERS[found.agent]);
    return { file: shown(found.path, home), agent: found.agent, place: found.place, level, outdated };
  });
  const sending = files.some((file) => ADAPTERS[file.agent].install.sending.includes(file.level));
  const extra = {};
  if (dependencies && sending) {
    extra.harnessCredential = (await readHarnessCredential(dependencies)) ? "present" : "missing";
    const queued = await pending({ directory: dependencies.outboxDirectory }).catch(() => undefined);
    if (queued) extra.pending = queued.observed;
  }
  return { level: files.length === 0 ? "off" : files.length === 1 ? files[0].level : "custom", files, ...extra };
}

/**
 * Removes Relo's hooks everywhere. Returns { removable, credential } where credential is the revoke
 * state (none | revoked | removed_locally), or undefined on a dry run.
 */
export async function turnHooksOff(probe, dependencies, { dryRun = false } = {}) {
  const plans = [];
  for (const found of findHooks(probe)) plans.push(await planLevelFile(found.path, found.agent, "off"));
  const removable = plans.filter(({ plan }) => plan.action === "removed");
  if (dryRun) return { removable };
  for (const item of removable) await commitLevel(item);
  const { state } = await revokeHarnessCredential(dependencies);
  await discard({ directory: dependencies.outboxDirectory, lane: "observed" }).catch(() => {});
  return { removable, credential: state };
}

export async function runHooksCommand(command) {
  const { options, group, action, rest, dependencies } = command;
  if (group !== "hooks") return undefined;
  assertNoExtra(rest, 0, USAGE);
  const probe = { env: dependencies.env, home: dependencies.home, cwd: dependencies.cwd };
  if (action === "status") {
    assertAllowedOptions(options, []);
    return result("hooks", await hooksStatus(probe, dependencies));
  }
  if (action === "off") {
    assertAllowedOptions(options, ["dry-run"]);
    const dryRun = Boolean(options["dry-run"]);
    const { removable, credential } = await turnHooksOff(probe, dependencies, { dryRun });
    return result("hooks", { action: removable.length ? "removed" : "unchanged", level: "off",
      files: removable.map(({ path }) => shown(path, probe.home)),
      ...(credential && credential !== "none" ? { harnessCredential: credential } : {}),
      ...(dryRun ? { dryRun: true } : {}) });
  }
  throw new UsageError(action === undefined ? "relo hooks needs an action." : `Unknown hooks action "${action}".`, { hint: USAGE });
}
