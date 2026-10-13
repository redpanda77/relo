import { requireText } from "../args.mjs";
import { UsageError } from "../errors.mjs";
import { detectAccount } from "../identity.mjs";
import { assertAllowedOptions } from "../support.mjs";
import { result } from "../support.mjs";

const USAGE = "Usage: relo account [NAME] [--clear]";

function describe(dependencies) {
  const found = detectAccount(dependencies.env, dependencies.accountProbes);
  return {
    account: found.account ?? null,
    ...(found.via === undefined ? {} : { via: found.via }),
    agent: found.agent ?? null,
    configDir: found.configDirectory ?? null,
  };
}

/** `relo account [NAME] [--clear]`: the nickname for the agent account that is running this command. */
export async function runAccountCommand(command) {
  const { options, group, action, rest, dependencies } = command;
  if (group !== "account") return undefined;
  assertAllowedOptions(options, ["clear"]);
  const words = [action, ...rest].filter((word) => word !== undefined);
  if (words.length > 1 || (words.length === 1 && options.clear)) throw new UsageError(USAGE);
  if (words.length === 0 && !options.clear) return result("account", describe(dependencies));

  const current = describe(dependencies);
  const accountKey = detectAccount(dependencies.env, dependencies.accountProbes).accountKey;
  if (accountKey === undefined) {
    throw new UsageError("No agent harness detected here, so there is nothing to name.", {
      hint: "Run this inside an agent, or set RELO_ACCOUNT=NAME (and RELO_SOURCE) in the environment",
    });
  }
  const name = options.clear ? undefined : requireText(words[0], "Account name", 40);
  const path = dependencies.configPath();
  const config = await dependencies.loadStoredConfig(path);
  const accounts = { ...config.accounts };
  if (name === undefined) delete accounts[accountKey];
  else accounts[accountKey] = name;
  await dependencies.writeConfig(path, { ...config, accounts }, { expectedRevision: config.revision });
  const probes = { ...dependencies.accountProbes, accounts: () => accounts };
  const after = detectAccount(dependencies.env, probes);
  return result("account", {
    account: after.account ?? null,
    ...(after.via === undefined ? {} : { via: after.via }),
    agent: after.agent ?? null,
    configDir: after.configDirectory ?? null,
    ...(name === undefined ? { cleared: true } : { saved: true }),
  });
}
