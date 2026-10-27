import { assertNoExtra } from "../shared/validate.mjs";
import { result } from "../shared/outcome.mjs";
import { statePath } from "../work/state-file.mjs";
import { claudeAccount, claudeFolders } from "./usage/claude.mjs";
import { codexAccount, codexFolders } from "./usage/codex.mjs";
import { antigravityAccount } from "./usage/antigravity.mjs";
import { opencodeAccount } from "./usage/opencode.mjs";
import { fetchJson, loopbackPost, runProgram } from "./usage/io.mjs";

const left = (resetsAt, now) => {
  const minutes = Math.max(0, Math.round((resetsAt * 1000 - now) / 60_000));
  return minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h` : minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
};

/** A short table for a person: one block per account. */
export function usageText(accounts, now) {
  if (accounts.length === 0) return "No AI plan accounts found on this computer.";
  return accounts.map((account) => {
    const head = [account.displayName ?? account.id, account.email ?? "(unknown account)", account.planName].filter(Boolean).join("  ");
    const rows = account.windows.map((window) => `  ${(window.label ?? window.kind).padEnd(16)} ${String(Math.round(window.usedPercent)).padStart(3)}% used, resets in ${left(window.resetsAt, now)}`);
    if (rows.length === 0) rows.push(`  no reading yet${account.hint ? ` (${account.hint})` : ""}`);
    else if (account.hint) rows.push(`  ${account.hint}`);
    if (account.activity) rows.push(`  tokens: ${account.activity.tokensToday} today, ${account.activity.tokensMonth} this month`);
    return [head, ...rows].join("\n");
  }).join("\n");
}

/**
 * `relo usage [--json]`: each AI plan account on this computer and its usage windows. Local and read-only: Claude's
 * from the status line's last recording or else Claude Code's own /usage, Codex's from the newest session rollout or else its
 * account endpoint, Antigravity's from its running language server, OpenCode's from its Go plan endpoint (or its API-key
 * activity). Anything that costs a request or a process is cached per account in the state folder. A reading, not Relo state:
 * it never touches the outbox, the server or any card. `dependencies.usageIo` ({ fetch, run, post }) swaps the I/O in tests.
 */
export async function runUsageCommand(command) {
  const { group, action, rest, dependencies } = command;
  if (group !== "usage") return undefined;
  assertNoExtra([action, ...rest].filter((word) => word !== undefined), 0, "Usage: relo usage [--json]");
  const env = dependencies.env ?? process.env;
  const home = dependencies.home;
  const now = (dependencies.now ?? Date.now)();
  const stateDirectory = statePath({ env, home });
  const io = { fetch: fetchJson, run: runProgram, post: loopbackPost, ...dependencies.usageIo };
  const accounts = [];
  for (const folder of await claudeFolders({ env, home })) accounts.push(await claudeAccount(folder, { home, stateDirectory, now, env, run: dependencies.runClaudeUsage }));
  for (const folder of await codexFolders({ env, home })) accounts.push(await codexAccount(folder, { now, stateDirectory, fetcher: io.fetch }));
  for (const reader of [antigravityAccount, opencodeAccount]) {
    const account = await reader({ env, home, stateDirectory, now, io }).catch(() => undefined);
    if (account) accounts.push(account);
  }
  return { ...result("usage", { accounts }), text: usageText(accounts, now) };
}
