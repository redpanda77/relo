// `relo uninstall [--apply]`: everything Relo wrote on this computer, Relo's parts only: the instruction
// blocks (a block marked relo:keep stays), the skill copies (moved to ~/.local/share/relo/skill-archives),
// the hook entries and the harness credential, the MCP entries. Without --apply it only lists them.
import { applyPlan, uninstallPlan } from "../install/plan.mjs";
import { installResult } from "./install-report.mjs";

export async function runUninstallCommand({ options, dependencies }) {
  const apply = Boolean(options.apply);
  const report = await applyPlan(uninstallPlan(dependencies), { dryRun: !apply, home: dependencies.home });
  if (apply) await dependencies.sendMachineReport?.();
  const next = apply
    ? ["relo auth logout   (optional: forget this computer's sign-in)", "npm uninstall --global @relo/cli"]
    : report.changed.length ? ["relo uninstall --apply   (removes what is listed above)"] : ["npm uninstall --global @relo/cli"];
  return installResult("uninstall", report, { dryRun: !apply, next, title: "Removed" });
}
