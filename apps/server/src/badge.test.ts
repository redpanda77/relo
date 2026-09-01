import { describe, expect, test, vi } from "vitest";
import type { Database } from "./db.js";
import { pendingInteractionBadgeCount } from "./badge.js";

describe("pending interaction badge count", () => {
  test("counts only current pending interactions visible to the exact device", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ count: 4 }], rowCount: 1 });
    const count = await pendingInteractionBadgeCount({ query } as unknown as Database,"device-uuid");

    expect(count).toBe(4);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("r.state='pending' AND r.expires_at>now()"),["device-uuid"]);
    expect(query.mock.calls[0]![0]).toContain("t.device_id=d.id");
    expect(query.mock.calls[0]![0]).toContain("d.principal_id=e.principal_id");
  });
});
