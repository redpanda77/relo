import { describe,expect,test } from "vitest";
import { presence,reconcile } from "./presence.js";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const ms = (minutes: number) => NOW - minutes * 60_000;

describe("an observed stop is honoured",() => {
  const stopped = (minutes: number) => ({ phase: "stopped" as const,phaseSince: at(minutes),lastSeenAt: at(minutes),openToolSince: null });

  test("a stop after the last declared write is the owner's turn, never working",() => {
    // The card's last write was 15 minutes ago (still inside T_fresh); the owner interrupted 2 minutes ago.
    const turn = reconcile(presence(stopped(2),NOW),{ lastDeclaredAt: ms(15),waitingSince: null },NOW);
    expect(turn.kind).toBe("your_turn");
  });

  test("past the owner's turn the older write does not turn the stop back into working",() => {
    const idle = reconcile(presence(stopped(8),NOW),{ lastDeclaredAt: ms(15),waitingSince: null },NOW);
    expect(idle.kind).toBe("idle");
    const later = reconcile(presence(stopped(30),NOW),{ lastDeclaredAt: ms(35),waitingSince: null },NOW);
    expect(later.kind).toBe("idle");
  });

  test("a declared write after the stop means the agent went on",() => {
    expect(reconcile(presence(stopped(8),NOW),{ lastDeclaredAt: ms(1),waitingSince: null },NOW).kind).toBe("working");
  });
});

