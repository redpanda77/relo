#!/usr/bin/env node
// The skill's numbers and exit codes come from the CLI (plan 10 D4): the same facts the docs and help read
// (packages/contracts/src/facts.ts, through the CLI's generated copy) and the CLI's exit-code table. Inline
// markers `<!--f:ID-->…<!--/f-->` (or `<!--f:ID short-->`) hold one fact; `<!--generated:exit-codes-->` … 
// `<!--/generated-->` holds the exit table. `node scripts/generate-facts.mjs` rewrites them; `--check` fails when
// one is stale (validate-skill.mjs runs it).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { factText } from "../../../packages/cli/src/shared/facts.mjs";
import { EXIT_CODES } from "../../../packages/cli/src/shared/errors.mjs";

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["SKILL.md", ...readdirSync(join(SKILL, "references")).filter((name) => name.endsWith(".md")).map((name) => `references/${name}`)];

const exitTable = () => ["| Exit | Meaning |", "| ---: | --- |",
  ...EXIT_CODES.map(({ code, doc }) => `| \`${code}\` | ${doc} |`)].join("\n");

export function generated(text) {
  return text
    .replace(/<!--f:([a-zA-Z.]+)( short)?-->[\s\S]*?<!--\/f-->/gu, (_, id, short) => `<!--f:${id}${short ?? ""}-->${factText(id, { short: Boolean(short) })}<!--/f-->`)
    .replace(/<!--generated:exit-codes-->[\s\S]*?<!--\/generated-->/gu, () => `<!--generated:exit-codes-->\n${exitTable()}\n<!--/generated-->`);
}

export function staleFiles() {
  return FILES.filter((file) => { const text = readFileSync(join(SKILL, file), "utf8"); return generated(text) !== text; });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const stale = staleFiles();
    if (stale.length) { console.error(`Stale generated facts in ${stale.join(", ")}: node scripts/generate-facts.mjs`); process.exit(1); }
  } else {
    for (const file of FILES) writeFileSync(join(SKILL, file), generated(readFileSync(join(SKILL, file), "utf8")));
  }
}
