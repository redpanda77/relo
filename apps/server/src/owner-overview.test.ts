import { describe,expect,test } from "vitest";
import { isOwnerOverview,OWNER_OVERVIEW,ownerOverviewSql,readsAccount,visibilityDeviceId } from "./owner-overview.js";
import { DEVICE_CAPABILITIES,deviceCapabilitiesSchema } from "./schemas.js";

// docs/CHOICE-QUESTIONS.md, "Device capabilities": delivery stays strict, visibility is account-level.
describe("owner overview devices",() => {
  test("a phone's reads are bounded by its delivery targets; the browser's and an overview device's are not",() => {
    expect(visibilityDeviceId({ deviceId: "phone" })).toBe("phone");
    expect(visibilityDeviceId({ deviceId: "mac",ownerOverview: true })).toBeUndefined();
    expect(visibilityDeviceId({})).toBeUndefined();
    expect(readsAccount({ deviceId: "mac",ownerOverview: true })).toBe(true);
    expect(readsAccount({ deviceId: "phone" })).toBe(false);
    // The browser reads the whole account too, but answers through its own route, not as a device.
    expect(readsAccount({ ownerOverview: true })).toBe(false);
  });

  test("the capability is declared, stored and recognized under one name",() => {
    expect(DEVICE_CAPABILITIES).toContain(OWNER_OVERVIEW);
    expect(deviceCapabilitiesSchema.parse(["owner_overview","choice_questions","owner_overview"])).toEqual(["choice_questions","owner_overview"]);
    expect(() => deviceCapabilitiesSchema.parse(["owner_everything"])).toThrow();
    expect(isOwnerOverview(["choice_questions","owner_overview"])).toBe(true);
    expect(isOwnerOverview(["choice_questions"])).toBe(false);
    expect(isOwnerOverview(null)).toBe(false);
    expect(ownerOverviewSql("d")).toBe("('owner_overview'=ANY(d.capabilities))");
  });
});
