import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditPublicFiles,
  isLicenseOnlyCandidate,
  parseTargetArgument,
  selectPublicPaths,
  trackedPaths,
} from "./public-export.mjs";

const manifest = {
  rootFiles: [".gitignore", "README.md", "LICENSE", "SECURITY.md"],
  roots: [".github", "apps", "docs"],
  allowedDotPaths: [".github/", ".gitignore", "apps/web/.env.example"],
  excludedPrefixes: ["docs/internal/"],
  requiredFiles: ["README.md", "LICENSE", "SECURITY.md"],
  forbiddenText: [{ id: "private-host", value: "private.example", caseSensitive: false }],
};

const regularFile = { isFile: () => true, isSymbolicLink: () => false };

test("selectPublicPaths keeps only allowlisted product source", () => {
  assert.deepEqual(selectPublicPaths([
    ".codex/hooks.json",
    "README.md",
    "apps/server/index.ts",
    "docs/internal/notes.md",
    "docs/SELF-HOSTING.md",
    "ROADMAP.md",
  ], manifest), ["README.md", "apps/server/index.ts", "docs/SELF-HOSTING.md"]);
});

test("selectPublicPaths requires explicit approval for every dot path", () => {
  assert.deepEqual(selectPublicPaths([
    ".github/workflows/ci.yml",
    ".gitignore",
    "apps/.secret/token",
    "apps/web/.cache/index.json",
    "apps/web/.env",
    "apps/web/.env.example",
  ], manifest), [
    ".github/workflows/ci.yml",
    ".gitignore",
    "apps/web/.env.example",
  ]);
});

test("auditPublicFiles reports missing files and private text", async () => {
  const blockers = await auditPublicFiles({
    paths: ["README.md"],
    manifest,
    readText: async () => "Connect to PRIVATE.example now.",
    stat: async () => regularFile,
  });
  assert.deepEqual(blockers, [
    { rule: "required-file", path: "LICENSE" },
    { rule: "required-file", path: "SECURITY.md" },
    { rule: "private-host", path: "README.md", line: 1 },
  ]);
});

test("auditPublicFiles accepts a clean complete candidate", async () => {
  const paths = ["LICENSE", "README.md", "SECURITY.md"];
  assert.deepEqual(await auditPublicFiles({
    paths,
    manifest,
    readText: async (path) => `Public ${path}`,
    stat: async () => regularFile,
  }), []);
});

test("auditPublicFiles rejects symbolic links", async () => {
  const blockers = await auditPublicFiles({
    paths: ["LICENSE", "README.md", "SECURITY.md"],
    manifest,
    readText: async () => "clean",
    stat: async (path) => ({ isFile: () => true, isSymbolicLink: () => path === "README.md" }),
  });
  assert.deepEqual(blockers, [{ rule: "symbolic-link", path: "README.md" }]);
});

test("only an absent license may enter non-publishable clean-host staging", () => {
  assert.equal(isLicenseOnlyCandidate([
    { rule: "required-file", path: "LICENSE" },
  ]), true);
  assert.equal(isLicenseOnlyCandidate([]), false);
  assert.equal(isLicenseOnlyCandidate([
    { rule: "required-file", path: "LICENSE" },
    { rule: "private-host", path: "README.md", line: 1 },
  ]), false);
  assert.equal(isLicenseOnlyCandidate([
    { rule: "required-file", path: "SECURITY.md" },
  ]), false);
});

test("target parsing accepts pnpm's optional separator and rejects ambiguity", () => {
  assert.equal(parseTargetArgument(["/tmp/relo"]), "/tmp/relo");
  assert.equal(parseTargetArgument(["--", "/tmp/relo"]), "/tmp/relo");
  assert.equal(parseTargetArgument([]), undefined);
  assert.equal(parseTargetArgument(["one", "two"]), undefined);
});

test("trackedPaths reads a NUL-separated list in a tree without .git", () => {
  const read = [];
  const paths = trackedPaths("/no/git/here", {
    filesFrom: "/tmp/files",
    readList: (path) => { read.push(path); return "README.md\0apps/server/src/app.ts\0"; },
  });
  assert.deepEqual(paths, ["README.md", "apps/server/src/app.ts"]);
  assert.deepEqual(read, ["/tmp/files"]);
});
