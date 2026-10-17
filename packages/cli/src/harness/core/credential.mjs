// The harness credential (HA.1): hook traffic is observed-only by construction. One per computer,
// minted with the owner's CLI credential when hooks that send are installed (or lazily by the outbox
// flusher), stored beside the CLI config as `harness-credential` (0600): { apiUrl, id, token }. It can
// only post observed snapshots; the CLI credential never calls the observed route.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cleanLabel as label } from "../../shared/label.mjs";
import { resolveComputerName } from "../../shared/computer.mjs";

function harnessCredentialPath(dependencies) {
  // process.env too: a caller's own env object (as in tests) must never fall back to the real file.
  return dependencies.env?.RELO_HARNESS_CREDENTIAL_PATH || process.env.RELO_HARNESS_CREDENTIAL_PATH
    || join(dirname(dependencies.configPath()), "harness-credential");
}

const valid = (value) => value && typeof value === "object" && typeof value.apiUrl === "string" && value.apiUrl
  && typeof value.id === "string" && value.id && typeof value.token === "string" && value.token;

export async function readHarnessCredential(dependencies) {
  try {
    const value = JSON.parse(await readFile(harnessCredentialPath(dependencies), "utf8"));
    return valid(value) ? { apiUrl: value.apiUrl, id: value.id, token: value.token } : undefined;
  } catch {
    return undefined;
  }
}

async function writeHarnessCredential(dependencies, value) {
  const path = harnessCredentialPath(dependencies);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}

export async function removeHarnessCredential(dependencies) {
  await rm(harnessCredentialPath(dependencies), { force: true });
}

function computerLabel(dependencies, config) {
  return resolveComputerName(dependencies.env, {
    cached: () => config?.computerName ?? dependencies.loadComputerName?.(),
    detect: () => dependencies.computerName?.(),
  }) ?? "computer";
}

/** Mints a new harness credential with the CLI credential and stores it. Throws on failure. */
export async function mintHarnessCredential(dependencies) {
  const config = await dependencies.loadConfig(dependencies.configPath());
  const client = dependencies.clientFactory(config);
  const response = await client.createHarnessCredential({ name: computerLabel(dependencies, config) });
  const value = { apiUrl: String(config.apiUrl).replace(/\/$/u, ""), id: response?.id, token: response?.token };
  if (!valid(value)) throw new Error("the server returned no harness credential");
  await writeHarnessCredential(dependencies, value);
  return value;
}

/** The stored credential, or a freshly minted one. Throws when there is none and minting fails. */
export async function ensureHarnessCredential(dependencies) {
  return (await readHarnessCredential(dependencies)) ?? mintHarnessCredential(dependencies);
}

/**
 * Revokes the stored credential on the server (with the CLI credential) and deletes the file.
 * Returns { state: "none" | "revoked" | "removed_locally" }: removed_locally means the server could not
 * be reached or refused, so the owner may revoke it from the dashboard.
 */
export async function revokeHarnessCredential(dependencies) {
  const stored = await readHarnessCredential(dependencies);
  if (!stored) {
    await removeHarnessCredential(dependencies);
    return { state: "none" };
  }
  let state = "revoked";
  try {
    const config = await dependencies.loadConfig(dependencies.configPath());
    await dependencies.clientFactory(config).revokeHarnessCredential(stored.id);
  } catch (error) {
    if (error?.status !== 404) state = "removed_locally";
  }
  await removeHarnessCredential(dependencies);
  return { state };
}
