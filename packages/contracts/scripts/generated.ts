import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FACTS, FACT_UNITS } from "../src/facts.js";
import { LOGIN_SCOPES, SCOPES } from "../src/scopes.js";
import { COMPUTER_ICONS } from "../src/computers.js";

/**
 * The CLI's copies of contracts data (plan 10 M6.2): the CLI ships without dependencies, so it reads committed
 * .mjs files written from these sources. `generated.test.ts` fails when one is stale; `UPDATE_GENERATED=1` (or
 * `pnpm --filter @relo/notification-contracts generate`) rewrites them.
 */
const CLI_SHARED = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/src/shared");

const header = (source: string) =>
  `// Generated from packages/contracts/src/${source} by packages/contracts/scripts/generated.ts. Do not edit:\n`
  + "// change the source, then run `pnpm --filter @relo/notification-contracts generate`.\n";
const deepFreeze = (name: string, value: unknown) => `export const ${name} = deepFreeze(${JSON.stringify(value, null, 2)});\n`;
const FREEZE = "function deepFreeze(value) {\n  for (const child of Object.values(value)) if (child && typeof child === \"object\") deepFreeze(child);\n  return Object.freeze(value);\n}\n";

/** A dependency-free contracts module, transpiled as is (no imports allowed, so the copy cannot drift). */
function transpiled(source: string): string {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), "../src", source);
  const code = readFileSync(path, "utf8");
  if (/^import\s/mu.test(code)) throw new Error(`${source} must not import anything: the CLI copies it as is`);
  return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: false } }).outputText;
}

export function generatedFiles(): Record<string, string> {
  return {
    [resolve(CLI_SHARED, "origin.generated.mjs")]: `${header("origin.ts")}${transpiled("origin.ts")}`,
    [resolve(CLI_SHARED, "plan-engine.generated.mjs")]: `${header("plan-engine.ts")}${transpiled("plan-engine.ts")}`,
    [resolve(CLI_SHARED, "facts.generated.mjs")]: `${header("facts.ts")}${FREEZE}\n${deepFreeze("FACTS", FACTS)}\n${deepFreeze("FACT_UNITS", FACT_UNITS)}`,
    [resolve(CLI_SHARED, "computers.generated.mjs")]: `${header("computers.ts")}${FREEZE}\n${deepFreeze("COMPUTER_ICONS", [...COMPUTER_ICONS])}`,
    [resolve(CLI_SHARED, "scopes.generated.mjs")]: `${header("scopes.ts")}${FREEZE}\n${deepFreeze("SCOPES", SCOPES)}\n${deepFreeze("LOGIN_SCOPES", LOGIN_SCOPES)}`,
  };
}

export function staleGeneratedFiles(): string[] {
  return Object.entries(generatedFiles()).filter(([path, contents]) => {
    try { return readFileSync(path, "utf8") !== contents; } catch { return true; }
  }).map(([path]) => path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [path, contents] of Object.entries(generatedFiles())) writeFileSync(path, contents);
  console.log("Generated the CLI's facts, scopes, computer icons and plan engine.");
}
