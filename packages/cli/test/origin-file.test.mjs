import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLifecycleIdentity,readPrivateOriginFile } from "../src/origin-file.mjs";

const origin = {
  sourceInstance: "codex-installation",project: "relo",
  thread: "opaque-thread",channel: "task-progress",
};

function dependencies({ mode = 0o100600,uid = 501,size = 128,contents = JSON.stringify(origin) } = {}) {
  return {
    platform: "darwin",uid: 501,
    lstatImpl: async () => ({
      mode,uid,size,isFile: () => true,isSymbolicLink: () => false,
    }),
    readFileImpl: async () => contents,
  };
}

test("reads a bounded owner-only origin descriptor",async () => {
  assert.deepEqual(await readPrivateOriginFile("/private/origin.json",dependencies()),origin);
  assert.deepEqual(await readPrivateOriginFile("/private/origin.json",dependencies({
    contents: JSON.stringify({ origin }),
  })),origin);
});

test("rejects permissive, foreign, linked, oversized, and malformed origin files",async () => {
  await assert.rejects(readPrivateOriginFile("/private/origin.json",dependencies({ mode: 0o100644 })),/0600/);
  await assert.rejects(readPrivateOriginFile("/private/origin.json",dependencies({ uid: 502 })),/owned/);
  await assert.rejects(readPrivateOriginFile("/private/origin.json",dependencies({ size: 33 * 1024 })),/too large/);
  await assert.rejects(readPrivateOriginFile("/private/origin.json",dependencies({ contents: "{" })),/valid JSON/);
  await assert.rejects(readPrivateOriginFile("/private/origin.json",dependencies({
    contents: JSON.stringify({ ...origin,prompt: "must not be accepted" }),
  })),/complete origin/);
  await assert.rejects(readPrivateOriginFile("/private/origin.json",{
    ...dependencies(),lstatImpl: async () => ({
      mode: 0o100600,uid: 501,size: 10,isFile: () => true,isSymbolicLink: () => true,
    }),
  }),/regular file/);
});

test("normalizes only opaque bounded lifecycle identities",() => {
  assert.deepEqual(normalizeLifecycleIdentity({ provider: "codex",runId: "codex-run-123" }),{
    provider: "codex",runId: "codex-run-123",
  });
  assert.throws(() => normalizeLifecycleIdentity({ provider: "Codex",runId: "run" }),/Lifecycle identity/);
  assert.throws(() => normalizeLifecycleIdentity({ provider: "codex",runId: "raw id" }),/Lifecycle identity/);
  assert.throws(() => normalizeLifecycleIdentity({ provider: "codex",runId: "run",prompt: "secret" }),/Lifecycle identity/);
});
