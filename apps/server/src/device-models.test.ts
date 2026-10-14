import { describe,expect,test } from "vitest";
import { friendlyModelName,isSimulatorModel } from "./device-models.js";

describe("friendly device model names",() => {
  test("maps Apple identifiers, labels simulators, and keeps unknown ids",() => {
    expect(friendlyModelName("iPhone10,3")).toBe("iPhone X");
    expect(friendlyModelName("iPhone18,1")).toBe("iPhone 17 Pro");
    expect(friendlyModelName("iPhone18,4")).toBe("iPhone Air");
    expect(friendlyModelName("iPhone19,7")).toBe("iPhone 18 Pro Max");
    expect(friendlyModelName("iPad16,3")).toBe("iPad Pro 11-inch (M4)");
    expect(friendlyModelName("Watch7,5")).toBe("Apple Watch Ultra 2");
    for (const model of ["arm64","x86_64","i386"]) {
      expect(friendlyModelName(model)).toBe("Simulator");
      expect(isSimulatorModel(model)).toBe(true);
    }
    expect(friendlyModelName("iPhone18,1",true)).toBe("Simulator");
    expect(friendlyModelName("iPhone99,1")).toBe("iPhone99,1");
    expect(friendlyModelName(null)).toBeNull();
    expect(isSimulatorModel("iPhone18,1")).toBe(false);
  });
});
