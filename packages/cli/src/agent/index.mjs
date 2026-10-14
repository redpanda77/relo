// The agent-session module (plan 04 §0.1): relo work, relo state; relo activity is gone for agents (D11).
import { WorkRefusal } from "../work/refusal.mjs";
import { runAgentState, runAgentWork } from "./work.mjs";

const ACTIVITY_TO_WORK = { start: 'relo work start --goal "…"', update: 'relo work update --status "…"', end: 'relo work finish --outcome "…"', status: "relo state", get: "relo state" };

export async function runAgentCommand(command) {
  const { group, action } = command;
  // DOGFOOD #11: `relo work state` is the same command as `relo state`.
  if (group === "work" && action === "state") return runAgentState(command);
  if (group === "work") return runAgentWork(command, action);
  if (group === "state") return runAgentState(command);
  if (group === "activity") {
    throw new WorkRefusal("UNKNOWN_COMMAND", { what: `relo activity ${action ?? ""} is gone; work in a session is declared with relo work`.replace("  ", " "), state: "verbs: relo work start, update, pause, resume, finish, and relo state", next: ACTIVITY_TO_WORK[action] ?? 'relo work start --goal "…"' });
  }
  return undefined;
}
