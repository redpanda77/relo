import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Plan 10 M1: `credentials/` is the only code that writes a credential's token, secret, revocation or last use,
 * or computes a token digest. Other columns of those tables (titles, presentation policy) stay with their owners,
 * and reading credential rows is fine. Tests insert fixtures directly and are not scanned.
 */
const SOURCE = fileURLToPath(new URL(".", import.meta.url));
const TABLES = "principal_api_keys|device_credentials|harness_credentials|webhook_services";
const COLUMNS = "token_hash|secret_hash|secret_prefix|token_prefix|revoked_at|last_used_at";
const WRITE = new RegExp(`(?:UPDATE\\s+(?:${TABLES})\\b[^;\`]*?\\bSET\\b[^;\`]*?\\b(?:${COLUMNS})\\s*=|INSERT\\s+INTO\\s+(?:${TABLES})\\b)`, "isu");

const sources = (directory: string): string[] => readdirSync(directory,{ withFileTypes: true }).flatMap((entry) => {
  const path = join(directory,entry.name);
  if (entry.isDirectory()) return ["credentials","test-support","node_modules"].includes(entry.name) ? [] : sources(path);
  return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
});

describe("credentials module boundary", () => {
  test("no module outside credentials/ writes a credential column or inserts a credential", () => {
    const offenders = sources(SOURCE).filter((path) => WRITE.test(readFileSync(path,"utf8"))).map((path) => relative(SOURCE,path));
    expect(offenders).toEqual([]);
  });

  test("no module outside credentials/ computes a token digest", () => {
    const offenders = sources(SOURCE).filter((path) => {
      const text = readFileSync(path,"utf8");
      return /\b(?:hashToken|hashMachineToken|generateToken|plainDigest|machineDigest|webhookDigest|loginDigests)\s*\(/u.test(text)
        && /from\s+"[./]*(?:auth|credentials\/hash)\.js"/u.test(text);
    }).map((path) => relative(SOURCE,path));
    expect(offenders).toEqual([]);
  });
});

describe("webhooks module boundary", () => {
  test("only webhooks/ (and the request policy, which counts its writes) reads the resolved service", () => {
    const offenders = sources(SOURCE).filter((path) => !relative(SOURCE,path).startsWith("webhooks/") && relative(SOURCE,path) !== "request-policy.ts")
      .filter((path) => /\.(?:get|set)\("webhook(?:Service|Secret)"\)/u.test(readFileSync(path,"utf8"))).map((path) => relative(SOURCE,path));
    expect(offenders).toEqual([]);
  });
});
