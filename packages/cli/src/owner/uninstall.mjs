// `relo uninstall [--apply]`: everything Relo wrote on this computer, Relo's parts only: the instruction
// blocks (a block marked relo:keep stays), the skill copies (moved to ~/.local/share/relo/skill-archives),
// the hook entries and the harness credential, the MCP entries. Without --apply it only lists them.
// --agent NAME (repeatable): only that harness's parts; the shared credential and the other harnesses stay.
import { applyPlan, chooseHarnesses, uninstallPlan } from "../install/plan.mjs";
import { installResult } from "./install-report.mjs";

export async function runUninstallCommand({ options, dependencies }) {
  const apply = Boolean(options.apply);
  const names = [options.agent ?? []].flat();
  const probe = { env: dependencies.env, home: dependencies.home, cwd: dependencies.cwd, platform: dependencies.platform };
  const harnesses = names.length > 0 ? chooseHarnesses(names, probe) : undefined;
  const report = await applyPlan(uninstallPlan(dependencies, { harnesses }), { dryRun: !apply, home: dependencies.home });
  if (apply) await dependencies.sendMachineReport?.();
  const next = harnesses
    ? apply ? ["relo setup --show   (what is still installed)"] : report.changed.length ? ["relo uninstall --apply   (removes what is listed above)"] : []
    : apply
      ? ["relo auth logout   (optional: forget this computer's sign-in)", "npm uninstall --global @relo/cli"]
      : report.changed.length ? ["relo uninstall --apply   (removes what is listed above)"] : ["npm uninstall --global @relo/cli"];
  return installResult("uninstall", report, { dryRun: !apply, next, title: "Removed" });
}
