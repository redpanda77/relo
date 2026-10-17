import { describe,expect,test } from "vitest";
import { OBSERVED_SESSION_PHASES,type ObservedSessionPhase,type OwnerStateInput,type OwnerStateResult } from "@relo/notification-contracts";
import { deriveOwnerState } from "./owner-state.js";
import { deriveSessionRow } from "./sessions-view.js";

/**
 * Plan 14, workstream 5: the card and the Sessions row read one presence function and one reconcile rule, so for every
 * (phase x age x declared write) cell they agree through this table:
 *
 *   presence     card                            row
 *   needs_input  needs_you (permission)          waiting / input
 *   working      moving / working_quietly        working
 *   your_turn    waiting_on_you                  waiting / turn
 *   silent       stopped_responding              idle
 *   idle         quiet (session_idle)            idle
 *   ended        quiet (session_ended)           hidden (ended)
 */
const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

// Ages of the phase, in minutes: around the 5-minute turn, the 10-minute quiet, the 20-minute fresh and the hour marks.
const AGES = [0.5,3,4.9,5.1,8,9.9,10.1,15,19,21,45,61,120,300,470];
type Declared = "none" | "after_the_phase" | "before_the_phase" | "waiting";
const DECLARED: Declared[] = ["none","after_the_phase","before_the_phase","waiting"];

function cell(phase: ObservedSessionPhase,age: number,declared: Declared) {
  const since = at(age);
  const lastDeclaredAt = declared === "none" ? at(age + 90) : declared === "after_the_phase" ? at(age / 2)
    : declared === "before_the_phase" ? at(age + 1) : at(age + 1);
  const waitingSince = declared === "waiting" ? at(age + 1) : null;
  const observed = { phase,phaseSince: since,lastSeenAt: since,openToolSince: null };
  const card = deriveOwnerState({
    now: new Date(NOW).toISOString(),
    work: { lifecycle: "open",startedAt: at(age + 100),lastDeclaredAt,finishedAt: null,waitingSince,seenAt: null },
    question: null,
    evidence: { producer: "agent_session",session: observed },
  } as OwnerStateInput);
  const row = deriveSessionRow({ now: new Date(NOW).toISOString(),observed,lastDeclaredAt,waitingSince });
  return { card,row };
}

type Kind = "needs_input" | "working" | "your_turn" | "idle" | "ended";
function cardKind(card: OwnerStateResult): Kind | `unexpected:${string}` {
  if (card.state === "needs_you") return card.needsYou === "permission" ? "needs_input" : `unexpected:${card.needsYou}`;
  if (card.state === "moving" || card.state === "working_quietly") return "working";
  if (card.state === "waiting_on_you") return "your_turn";
  if (card.state === "stopped_responding") return "idle";
  if (card.state === "stale" || card.state === "no_signal") return card.quietReason === "session_ended" ? "ended" : "idle";
  return `unexpected:${card.state}`;
}
function rowKind(row: ReturnType<typeof deriveSessionRow>): Kind {
  if (row.phase === "ended") return "ended";
  if (row.phase === "waiting") return row.waitingFor === "input" ? "needs_input" : "your_turn";
  return row.phase === "working" ? "working" : "idle";
}

describe("the card and the Sessions row agree through the mapping table",() => {
  let cells = 0;
  for (const phase of OBSERVED_SESSION_PHASES) {
    for (const declared of DECLARED) {
      test(`${phase}, declared write ${declared}: every age`,() => {
        for (const age of AGES) {
          const { card,row } = cell(phase,age,declared);
          const label = `${phase} ${age}m ${declared}`;
          expect(cardKind(card),`${label}: card ${card.state}`).toBe(rowKind(row));
          // Hidden rows: an ended session, and a session never prompted.
          if (phase === "ended") expect(row.hidden,label).toBe(true);
          cells += 1;
        }
      });
    }
  }
  test("the grid covers every phase, age and declared case",() => {
    expect(OBSERVED_SESSION_PHASES.length * AGES.length * DECLARED.length).toBeGreaterThan(200);
    expect(cells).toBe(OBSERVED_SESSION_PHASES.length * AGES.length * DECLARED.length);
  });
});

describe("the one set of windows",() => {
  const kinds = (phase: ObservedSessionPhase,age: number,declared: Declared = "none") => {
    const { card,row } = cell(phase,age,declared);
    return [cardKind(card),rowKind(row)];
  };
  test("a stopped turn is your turn for 5 minutes on the card and in Sessions, then idle on both",() => {
    expect(kinds("stopped",4.9)).toEqual(["your_turn","your_turn"]);
    expect(kinds("stopped",5.1)).toEqual(["idle","idle"]);
    expect(kinds("stopped",15)).toEqual(["idle","idle"]);
  });
  test("a running turn silent for 10 minutes is stopped responding on the card and idle in Sessions",() => {
    expect(kinds("working",9.9)).toEqual(["working","working"]);
    const silent = cell("working",10.1,"none");
    expect(silent.card.state).toBe("stopped_responding");
    expect(silent.row.phase).toBe("idle");
  });
  test("a declared write after the phase cancels your turn and a permission prompt on both; a declared wait keeps working",() => {
    expect(kinds("stopped",4,"after_the_phase")).toEqual(["working","working"]);
    expect(kinds("stopped",19,"after_the_phase")).toEqual(["working","working"]);
    expect(kinds("stopped",45,"after_the_phase")).toEqual(["idle","idle"]);
    expect(kinds("waiting",4,"after_the_phase")).toEqual(["working","working"]);
    expect(kinds("waiting",4,"before_the_phase")).toEqual(["needs_input","needs_input"]);
    expect(kinds("stopped",30,"waiting")).toEqual(["working","working"]);
    expect(kinds("ended",30,"waiting")).toEqual(["ended","ended"]);
  });
  test("a permission prompt with a heartbeat source needs you while the heartbeat is current, and is silent on both surfaces once it stops",() => {
    const waiting = (heartbeatAgo: number | null,age = 45) => {
      const observed = { phase: "waiting" as const,phaseSince: at(age),lastSeenAt: at(age),openToolSince: null,
        ...(heartbeatAgo === null ? {} : { heartbeatAt: at(heartbeatAgo) }) };
      const lastDeclaredAt = at(age + 90);
      const card = deriveOwnerState({
        now: new Date(NOW).toISOString(),
        work: { lifecycle: "open",startedAt: at(age + 100),lastDeclaredAt,finishedAt: null,waitingSince: null,seenAt: null },
        question: null,
        evidence: { producer: "agent_session",session: observed },
      } as OwnerStateInput);
      const row = deriveSessionRow({ now: new Date(NOW).toISOString(),observed,lastDeclaredAt,waitingSince: null });
      return { card,row,kinds: [cardKind(card),rowKind(row)] };
    };
    expect(waiting(1).kinds).toEqual(["needs_input","needs_input"]);
    expect(waiting(9.9).kinds).toEqual(["needs_input","needs_input"]);
    expect(waiting(11).kinds).toEqual(["idle","idle"]);
    expect(waiting(11).card.needsYou).toBeNull();
    expect(waiting(null,45).kinds).toEqual(["needs_input","needs_input"]);
    // The boundary is an instant the card and the row both come back at.
    expect(waiting(9).card.nextChangeAt).toBe(new Date(NOW + 60_000).toISOString());
    expect(waiting(9).row.nextChangeAt).toBe(new Date(NOW + 60_000).toISOString());
  });
  test("a session started and never prompted is hidden from Sessions until its first prompt",() => {
    const { row } = cell("open",3,"none");
    expect(row).toMatchObject({ phase: "idle",hidden: true,nextChangeAt: null });
  });
});
