import { UsageError } from "../errors.mjs";
import { bundledSkillDirectory, chooseSkillRoot, installSkill, removeSkill, skillStatus } from "../skill.mjs";
import { assertAllowedOptions, assertNoExtra, result } from "../support.mjs";

const USAGE = "Usage: relo skill install (--agent NAME | --dir PATH) [--dry-run] | relo skill remove (--agent NAME | --dir PATH) [--dry-run] | relo skill status";

/** `relo skill`: install, remove or list the relo-notifications skill that ships with this CLI. */
export async function runSkillCommand(command) {
  const { options, group, action, rest, dependencies } = command;
  if (group !== "skill") return undefined;
  assertNoExtra(rest, 0, USAGE);
  const { home, cwd, env, version } = dependencies;
  if (action === "status") {
    assertAllowedOptions(options, []);
    return result("skill.status", { cli: version, bundled: bundledSkillDirectory() !== undefined, copies: skillStatus({ env, home, cliVersion: version }) });
  }
  if (action !== "install" && action !== "remove") throw new UsageError(USAGE);
  assertAllowedOptions(options, ["agent", "dir", "dry-run"]);
  const chosen = chooseSkillRoot(options, { env, home, cwd });
  const args = { ...chosen, dryRun: Boolean(options["dry-run"]), home, now: dependencies.now() };
  const report = action === "install" ? await installSkill(args) : await removeSkill(args);
  return result(`skill.${action}`, report);
}
