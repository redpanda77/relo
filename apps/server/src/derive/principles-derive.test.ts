// ADR 0008 principles 1, 5 and 9 as sweeps over derive(): absence of evidence never reads as running,
// every item eventually leaves the Lock Screen, and declared lifecycle alone decides finished outcomes.
import { readFileSync } from "node:fs";
import { describe,expect,test } from "vitest";
import { WORK_LIFECYCLES,type OwnerStateInput } from "@relo/notification-contracts";
import { deriveOwnerState } from "./owner-state.js";

const fixture = JSON.parse(readFileSync(new URL("../../../../packages/contracts/fixtures/owner-state-v1.json",import.meta.url),"utf8"));
const base = fixture.derive[0].input as OwnerStateInput;
const at = (minutes: number) => new Date(Date.parse(base.work.lastDeclaredAt) + minutes * 60_000).toISOString();
const evidences: OwnerStateInput["evidence"][] = [
  { producer: "agent_session",session: null },
  { producer: "script",leaseUntil: null },
  { producer: "service",leaseUntil: null },
];

describe("ADR 0008 principle invariants over derive()",() => {
  test("principle 9: an open work with no new write leaves Running and the Lock Screen within a day, for every producer type",() => {
    for (const evidence of evidences) {
      const late = deriveOwnerState({ ...base,evidence,now: at(24 * 60) });
      expect(late.now).not.toBe("running");
      expect(["none","dimmed"]).toContain(late.lockScreen);
      expect(late.state).not.toBe("moving");
    }
  });

  test("principle 9: every lifecycle without a question is off the Lock Screen within a day",() => {
    for (const lifecycle of WORK_LIFECYCLES) {
      const finishedAt = lifecycle === "open" || lifecycle === "paused" ? null : base.work.lastDeclaredAt;
      const result = deriveOwnerState({ ...base,work: { ...base.work,lifecycle,finishedAt },now: at(24 * 60) });
      expect(result.lockScreen,lifecycle).toBe("none");
    }
  });

  test("principle 1: a declared outcome maps to its own state; derive never invents success",() => {
    const outcome = (lifecycle: "finished" | "failed" | "dropped") =>
      deriveOwnerState({ ...base,work: { ...base.work,lifecycle,finishedAt: base.work.lastDeclaredAt },now: at(1) }).state;
    expect(outcome("finished")).toBe("done");
    expect(outcome("failed")).toBe("failed");
    expect(outcome("dropped")).toBe("dropped");
  });

  test("principle 5: staleness only moves forward: the state at a later time is never fresher (moving) after it left moving",() => {
    for (const evidence of evidences) {
      let leftMoving = false;
      for (let minutes = 0; minutes <= 48 * 60; minutes += 5) {
        const state = deriveOwnerState({ ...base,evidence,now: at(minutes) }).state;
        if (leftMoving) expect(state,`${evidence.producer} at ${minutes}m`).not.toBe("moving");
        if (state !== "moving") leftMoving = true;
      }
    }
  });
});

describe("working layer: a delivered work (open, last round closed)",() => {
  const delivered = { ...base,work: { ...base.work,lifecycle: "open" as const,finishedAt: null,seenAt: null,roundClosedAt: base.work.lastDeclaredAt } };
  const run = (minutes: number,evidence: OwnerStateInput["evidence"] = { producer: "agent_session",session: null }) =>
    deriveOwnerState({ ...delivered,evidence,now: at(minutes) });

  test("it is an outcome, like a finished work: Done, the final card on the Lock Screen and Since you looked",() => {
    const result = run(1);
    expect(result).toMatchObject({ state: "done",needsYou: null,lockScreen: "final",now: "since_you_looked" });
    expect(result.nextChangeAt).not.toBeNull();
    // The final card lasts T_done; Since you looked keeps it until seen or T_history.
    expect(run(16)).toMatchObject({ state: "done",lockScreen: "none",now: "since_you_looked" });
  });

  test("it is never your turn, moving or stale, for every producer type",() => {
    for (const evidence of evidences) {
      for (let minutes = 0; minutes < 9 * 60; minutes += 15) expect(run(minutes,evidence).state).toBe("done");
    }
  });

  test("seen, or past T_history, it is History only",() => {
    const seen = deriveOwnerState({ ...delivered,work: { ...delivered.work,seenAt: at(2) },now: at(3) });
    expect(seen).toMatchObject({ state: "done",now: null });
    expect(run(8 * 60 + 1)).toMatchObject({ state: "done",lockScreen: "none",now: null });
  });

  test("a pending question still needs the owner; a write into a new round (round open again) moves it back",() => {
    const asked = deriveOwnerState({ ...delivered,now: at(1),question: { standing: "pending",askedAt: at(0),openedAt: null } });
    expect(asked.state).toBe("needs_you");
    const reopened = deriveOwnerState({ ...base,work: { ...base.work,roundClosedAt: null },now: at(1) });
    expect(reopened.state).toBe("moving");
  });

  test("nextChangeAt is where the output changes",() => {
    const result = run(1);
    const after = deriveOwnerState({ ...delivered,evidence: { producer: "agent_session",session: null },now: result.nextChangeAt! });
    expect([after.state,after.lockScreen]).not.toEqual([result.state,result.lockScreen]);
  });
});

describe("retiring and left open (12b-plan-ux 4.11)",() => {
  const session = (phase: "working" | "stopped" | "ended",sinceMinutes: number) => ({
    producer: "agent_session" as const,
    session: { phase,phaseSince: at(sinceMinutes),lastSeenAt: at(sinceMinutes),openToolSince: null },
  });
  const open = { ...base,work: { ...base.work,lifecycle: "open" as const,finishedAt: null,seenAt: null,roundClosedAt: null } };
  const delivered = { ...open,work: { ...open.work,roundClosedAt: at(0) } };
  const run = (input: OwnerStateInput,minutes: number,evidence?: OwnerStateInput["evidence"]) =>
    deriveOwnerState({ ...input,...(evidence ? { evidence } : {}),now: at(minutes) });

  test("delivered, with the session live or ended: the final card for T_done, then Since you looked",() => {
    for (const evidence of [undefined,session("ended",1)]) {
      expect(run(delivered,14,evidence)).toMatchObject({ state: "done",lockScreen: "final",now: "since_you_looked" });
      expect(run(delivered,16,evidence)).toMatchObject({ state: "done",lockScreen: "none",now: "since_you_looked" });
    }
  });

  test("left open: the turn ended 4 minutes ago is still your turn, 6 minutes ago it is Quiet and dimmed (session idle)",() => {
    const stopped = session("stopped",10);
    expect(run(open,14,stopped)).toMatchObject({ state: "waiting_on_you",now: "waiting_on_you" });
    expect(run(open,14,stopped).quietReason).toBeUndefined();
    const quiet = run(open,16,stopped);
    expect(quiet).toMatchObject({ state: "stale",lockScreen: "dimmed",now: "quiet",quietReason: "session_idle",quietSince: at(10) });
    expect(quiet.nextChangeAt).toBe(at(70));
    // Off the Lock Screen after an hour quiet, History after the existing history window.
    expect(run(open,71,stopped)).toMatchObject({ state: "no_signal",lockScreen: "none",now: "quiet",quietReason: "session_idle" });
    expect(run(open,10 + 8 * 60,stopped)).toMatchObject({ state: "left_unfinished",now: "since_you_looked" });
    expect(run(open,10 + 8 * 60,stopped).quietReason).toBeUndefined();
  });

  test("a declared wait is not left open; a pending question is Needs you, not Quiet",() => {
    const stopped = session("stopped",10);
    const waiting = { ...open,work: { ...open.work,waitingSince: at(10) } };
    expect(run(waiting,30,stopped)).toMatchObject({ state: "moving",now: "running" });
    const asked = deriveOwnerState({ ...open,evidence: stopped,now: at(30),question: { standing: "pending",askedAt: at(10),openedAt: null } });
    expect(asked).toMatchObject({ state: "needs_you",needsYou: "question" });
    expect(asked.quietReason).toBeUndefined();
  });

  test("session ended with the round open: Quiet at once with session_ended, a finished item's final card for T_done, then History only",() => {
    const ended = session("ended",1);
    expect(run(open,2,ended)).toMatchObject({ state: "stale",lockScreen: "dimmed",now: "quiet",quietReason: "session_ended",quietSince: at(1) });
    expect(run(open,2,ended).nextChangeAt).toBe(at(16));
    expect(run(open,15,ended)).toMatchObject({ state: "stale",lockScreen: "dimmed",now: "quiet" });
    // The 60-minute dimmed card is gone: after T_done it leaves the Lock Screen and Now, whatever the hour.
    for (const minutes of [16,17,62,5 * 60,9 * 60]) {
      expect(run(open,minutes,ended)).toMatchObject({ state: "no_signal",lockScreen: "none",now: null,quietReason: "session_ended" });
    }
  });

  test("an ended session never writes the work: a work with a declared wait still reads as ended, a question still needs the owner",() => {
    const ended = session("ended",1);
    const waiting = { ...open,work: { ...open.work,waitingSince: at(1) } };
    expect(run(waiting,30,ended)).toMatchObject({ state: "no_signal",now: null });
    const asked = deriveOwnerState({ ...open,evidence: ended,now: at(30),question: { standing: "pending",askedAt: at(10),openedAt: null } });
    expect(asked).toMatchObject({ state: "needs_you",needsYou: "question" });
  });

  test("without hooks the 20-minute rule stands, with no_update since the last write",() => {
    expect(run(open,19,{ producer: "agent_session",session: null }).quietReason).toBeUndefined();
    expect(run(open,21,{ producer: "agent_session",session: null }))
      .toMatchObject({ state: "stale",lockScreen: "dimmed",now: "quiet",quietReason: "no_update",quietSince: at(0) });
    for (const producer of ["script","service"] as const) {
      expect(run(open,25,{ producer,leaseUntil: null })).toMatchObject({ state: "stale",quietReason: "no_update" });
    }
  });

  test("a running turn is never quiet",() => {
    const working = session("working",19);
    expect(run(open,20,working).state).toBe("working_quietly");
    expect(run(open,20,working).quietReason).toBeUndefined();
  });
});
