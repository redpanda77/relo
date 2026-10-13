import { describe, expect, test } from "vitest";
import { dashboardReleaseIdentity, pageNumber } from "./http.js";

describe("dashboard http helpers", () => {
  test("normalizes history page numbers", () => {
    expect(pageNumber(undefined)).toBe(1);
    expect(pageNumber("2")).toBe(2);
    for (const value of ["0","-1","1.5","abc","9007199254740992"]) {
      expect(pageNumber(value)).toBe(1);
    }
  });

  test("normalizes a public release identity with a safe development fallback", () => {
    expect(dashboardReleaseIdentity(" 0.2.0 ")).toBe("0.2.0");
    expect(dashboardReleaseIdentity(undefined)).toBe("dev");
    expect(dashboardReleaseIdentity("<script>")).toBe("dev");
  });
});
