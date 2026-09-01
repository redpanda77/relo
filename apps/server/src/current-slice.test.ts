import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  activityDeliverySummarySchema,
  activityEndSchema,
  activityStartSchema,
  activityUpdateSchema,
} from "./activities.js";
import { notificationRequestSchema } from "./schemas.js";
import { publicHttpsUrlSchema } from "./url-policy.js";

describe("shared current-slice fixture", () => {
  test("server lifecycle boundaries accept the frozen request and delivery shapes", async () => {
    const fixture = JSON.parse(await readFile(
      new URL("../../../packages/contracts/fixtures/current-slice.json",import.meta.url),
      "utf8",
    )) as Record<string,unknown>;

    expect(notificationRequestSchema.parse(fixture.notification)).toEqual(fixture.notification);
    expect(activityStartSchema.parse(fixture.activityStart)).toEqual(fixture.activityStart);
    expect(activityUpdateSchema.parse(fixture.activityUpdate)).toEqual(fixture.activityUpdate);
    expect(activityEndSchema.parse(fixture.activityEnd)).toEqual(fixture.activityEnd);
    expect(activityDeliverySummarySchema.parse(fixture.delivery)).toEqual(fixture.delivery);
    expect(activityUpdateSchema.safeParse({ ...fixture.activityUpdate as object, sequence: 4 }).success).toBe(false);
    const urls = fixture.publicImageUrls as { accepted: string[]; rejected: string[] };
    for (const value of urls.accepted) expect(publicHttpsUrlSchema.safeParse(value).success).toBe(true);
    for (const value of urls.rejected) expect(publicHttpsUrlSchema.safeParse(value).success).toBe(false);
  });
});
