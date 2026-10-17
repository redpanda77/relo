import { readFileSync } from "node:fs";
import { describe,expect,test } from "vitest";
import type { OwnerStateInput } from "@relo/notification-contracts";
import { deriveOwnerState } from "./owner-state.js";

const fixture = JSON.parse(readFileSync(new URL("../../../../packages/contracts/fixtures/owner-state-v1.json",import.meta.url),"utf8"));
const base = fixture.derive[0].input as OwnerStateInput;
const NOW = Date.parse(base.work.lastDeclaredAt) + 60 * 60_000;
const MIN = 60_000;
const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();

/** A session in `phase` since `ageMinutes`, whose MCP heartbeat (when it has a source) came `heartbeatMinutes` ago and moved last-seen with it. */
function run(phase: "waiting" | "ended",ageMinutes: number,heartbeatMinutes: number | null,computerSeenMinutes: number | null = null,seenMinutes = heartbeatMinutes ?? ageMinutes) {
  const input: OwnerStateInput = {
    ...base,
    work: { ...base.work,lifecycle: "open",finishedAt: null,waitingSince: null,seenAt: null },
    question: null,
    now: new Date(NOW).toISOString(),
    evidence: {
      producer: "agent_session",
      session: { phase,phaseSince: ago(ageMinutes),lastSeenAt: ago(seenMinutes),openToolSince: null,
        ...(heartbeatMinutes === null ? {} : { heartbeatAt: ago(heartbeatMinutes) }) },
      ...(computerSeenMinutes === null ? {} : { computerLastSeenAt: ago(computerSeenMinutes) }),
    },
  };
  return deriveOwnerState(input);
}

describe("a permission wait needs the owner only while its session heartbeat is current",() => {
  for (const phase of ["waiting","ended"] as const) {
    for (const heartbeat of [1,9,11]) {
      for (const age of [1,9,45]) {
        const live = phase === "waiting" && heartbeat < 10;
        test(`${phase}, heartbeat ${heartbeat} min ago, waiting ${age} min: ${live ? "needs you" : "does not"}`,() => {
          const result = run(phase,age,heartbeat);
          if (live) {
            expect(result.state).toBe("needs_you");
            expect(result.needsYou).toBe("permission");
          } else {
            expect(result.needsYou).toBeNull();
            expect(result.state).not.toBe("needs_you");
          }
        });
      }
    }
  }

  test("a heartbeat 9 minutes ago ends the wait one minute from now, and nextChangeAt lands there",() => {
    const result = run("waiting",1,9);
    expect(result.needsYou).toBe("permission");
    expect(result.nextChangeAt).toBe(new Date(NOW + MIN).toISOString());
  });

  test("a prompt reached after the last heartbeat counts as seen then: a fresh wait is not silent",() => {
    expect(run("waiting",1,30,null,1).needsYou).toBe("permission");
  });

  test("without a heartbeat source the wait keeps today's rule: needs you until answered, up to the history window",() => {
    expect(run("waiting",60,null).needsYou).toBe("permission");
    expect(run("waiting",9 * 60,null).needsYou).toBeNull();
  });

  test("the computer's last-seen never gates a wait, with or without a heartbeat source",() => {
    expect(run("waiting",45,null,11).needsYou).toBe("permission");
    expect(run("waiting",45,1,500).needsYou).toBe("permission");
  });
});
