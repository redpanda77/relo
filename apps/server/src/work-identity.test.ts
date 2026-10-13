import { describe, expect, test } from "vitest";
import { requireWorkIdentity } from "./work-identity.js";

describe("required work identity", () => {
  test("rejects a missing or blank project and topic", () => {
    expect(requireWorkIdentity("svc",undefined,undefined)).toEqual({ ok: false,missing: ["project","topic"] });
    expect(requireWorkIdentity("svc",{ project: "Relo" },undefined)).toEqual({ ok: false,missing: ["topic"] });
    expect(requireWorkIdentity("svc",{ threadName: "Deploys" },undefined)).toEqual({ ok: false,missing: ["project"] });
  });

  test("accepts explicit context and derives a stable topic key", () => {
    const first = requireWorkIdentity("svc",{ project: "Relo",threadName: "Deploys" },undefined);
    const again = requireWorkIdentity("svc",{ project: "Relo",threadName: "Deploys" },undefined);
    const other = requireWorkIdentity("other",{ project: "Relo",threadName: "Deploys" },undefined);
    expect(first).toEqual({ ok: true,context: { project: "Relo",threadName: "Deploys",
      providerThreadId: expect.stringMatching(/^topic:[0-9a-f]{64}$/) } });
    expect(again).toEqual(first);
    expect(other.ok && first.ok && other.context.providerThreadId).not.toBe(first.ok && first.context.providerThreadId);
  });

  test("keeps a provider thread and lets an origin descriptor supply the hierarchy", () => {
    expect(requireWorkIdentity("svc",{ project: "Relo",threadName: "Deploys",providerThreadId: "thr_1" },undefined))
      .toEqual({ ok: true,context: { project: "Relo",threadName: "Deploys",providerThreadId: "thr_1" } });
    const origin = { sourceInstance: "mac",project: "Relo",thread: "Deploys",channel: "cli" };
    expect(requireWorkIdentity("svc",undefined,origin)).toEqual({ ok: true,context: { project: "Relo",threadName: "Deploys" } });
  });

  test("treats generic placeholders as missing, case-insensitively", () => {
    expect(requireWorkIdentity("svc",{ project: "Project",threadName: "Codex task" },undefined))
      .toEqual({ ok: false,missing: ["project","topic"] });
    expect(requireWorkIdentity("svc",{ project: "Codex work",threadName: "Completion" },undefined))
      .toEqual({ ok: false,missing: ["project","topic"] });
    expect(requireWorkIdentity("svc",{ project: "Relo",threadName: "Codex tasks backlog" },undefined).ok).toBe(true);
  });
});
