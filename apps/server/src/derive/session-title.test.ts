import { agentSessionObservedRequestSchema,sessionRowSchema } from "@relo/notification-contracts";
import { expect,test } from "vitest";
import { sessionsViewRows } from "./sessions-view.js";

const now = new Date("2026-10-26T12:00:00Z");
const row = (extra: Record<string,unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",session_hash: "hash-1",harness: "codex",computer: "mac",project: "relo",
  phase: "working",phase_since: now,last_seen_at: now,open_tool_since: null,heartbeat_at: null,started_at: now,
  card_id: null,...extra,
});
const snapshot = { session: "a".repeat(32),harness: "codex",phase: "working",phaseSince: now.toISOString(),
  lastSeenAt: now.toISOString(),openToolSince: null,seq: 1 };

test("the observed snapshot takes one readable title line",() => {
  expect(agentSessionObservedRequestSchema.safeParse({ ...snapshot,title: "Fix login" }).success).toBe(true);
  expect(agentSessionObservedRequestSchema.safeParse({ ...snapshot,title: "two\nlines" }).success).toBe(false);
  expect(agentSessionObservedRequestSchema.safeParse({ ...snapshot,title: "x".repeat(81) }).success).toBe(false);
});

test("a session row carries its stored readable title",() => {
  const [session] = sessionsViewRows([row({ title: "Fix login" })],now);
  expect(session!.title).toBe("Fix login");
  expect(sessionRowSchema.safeParse(session).success).toBe(true);
  expect(sessionsViewRows([row()],now)[0]!.title).toBeUndefined();
});

test("a session with no name at all takes its card's goal; a sealed or titled one does not",() => {
  const goalByKey = new Map([["hash-1","Ship the release"]]);
  expect(sessionsViewRows([row()],now,{ goalByKey })[0]!.title).toBe("Ship the release");
  expect(sessionsViewRows([row({ title: "Own name" })],now,{ goalByKey })[0]!.title).toBe("Own name");
  expect(sessionsViewRows([row({ sealed_names: { kind: "names" } })],now,{ goalByKey })[0]!.title).toBeUndefined();
});
