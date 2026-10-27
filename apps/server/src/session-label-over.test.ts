import { describe,expect,it } from "vitest";
import { sessionLabelOver } from "./agent-sessions.js";

describe("a session's label over the card's", () => {
  it("wins, except a handle over a readable name", () => {
    expect(sessionLabelOver("relo","old name")).toBe("relo");
    expect(sessionLabelOver("p-cbafdarfvmwue2t7","relo")).toBe("relo");
    expect(sessionLabelOver("p-cbafdarfvmwue2t7","p-aaaaaaaaaaaaaaaa")).toBe("p-cbafdarfvmwue2t7");
    expect(sessionLabelOver(null,"relo")).toBe("relo");
    expect(sessionLabelOver(undefined,null)).toBeNull();
  });
});
