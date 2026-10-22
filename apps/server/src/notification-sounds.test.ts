import { describe, expect, test } from "vitest";
import {
  activityAlertSound,cueFor,highestMoment,noticeMoment,noticeSound,ownerStateMoment,type SoundMoment,
} from "./notification-sounds.js";

describe("notification sounds (ADR 0013)", () => {
  test("each moment names its bundled .caf", () => {
    const moments: SoundMoment[] = ["needs_you","failed","your_turn","done"];
    expect(moments.map(cueFor)).toEqual(["needs-you.caf","failed.caf","your-turn.caf","done.caf"]);
  });

  test("the highest moment wins: needs you, failed, your turn, done", () => {
    expect(highestMoment(["done","failed"])).toBe("failed");
    expect(highestMoment([null,"done","your_turn"])).toBe("your_turn");
    expect(highestMoment(["done","needs_you","failed"])).toBe("needs_you");
    expect(highestMoment([null])).toBeNull();
  });

  test("notices: questions and access requests need you, outcomes are failed or done, a notify is none", () => {
    expect(noticeMoment({ interactionKind: "yes_no" })).toBe("needs_you");
    expect(noticeMoment({ payload: { answerInApp: true } })).toBe("needs_you");
    expect(noticeMoment({ payload: { questionFallback: { activityId: "act_1" } } })).toBe("needs_you");
    expect(noticeMoment({ payload: { deviceApproval: { deviceId: "dev_1" } } })).toBe("needs_you");
    expect(noticeMoment({ payload: { workOutcome: { result: "failed" } } })).toBe("failed");
    expect(noticeMoment({ payload: { workOutcome: { result: "delivered" } } })).toBe("done");
    expect(noticeMoment({ payload: { workOutcome: { result: "dropped" } } })).toBeNull();
    expect(noticeMoment({ payload: { privacy: "standard" } })).toBeNull();
    expect(noticeMoment({})).toBeNull();
    expect(noticeMoment({ payload: { workOutcome: "failed",browserLink: "x" } })).toBeNull();
  });

  test("a notice with no moment keeps the system default", () => {
    expect(noticeSound({ payload: {} })).toBe("default");
    expect(noticeSound({ interactionKind: "text" })).toBe("needs-you.caf");
  });

  test("card states: only the four moments cue, the quiet states do not", () => {
    expect(ownerStateMoment("needs_you")).toBe("needs_you");
    expect(ownerStateMoment("waiting_on_you")).toBe("your_turn");
    for (const state of ["dropped","left_unfinished","paused","moving","working_quietly","stale"] as const) {
      expect(ownerStateMoment(state)).toBeNull();
      expect(activityAlertSound(state)).toBeUndefined();
    }
    expect(activityAlertSound(undefined)).toBeUndefined();
    expect(activityAlertSound("done")).toBe("done.caf");
  });
});
