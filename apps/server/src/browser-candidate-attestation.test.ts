import { afterEach, describe, expect, test, vi } from "vitest";
import { createApp } from "./app.js";

const flag = "RELO_BROWSER_ISOLATED_CANDIDATE_API";
const originalFlag = process.env[flag];

afterEach(() => {
  if (originalFlag === undefined) delete process.env[flag];
  else process.env[flag] = originalFlag;
});

function candidateApp(databaseName: string, apnsMode: "disabled" | "sandbox" = "disabled") {
  const query = vi.fn(async (sql: string) => {
    if (sql === "SELECT current_database() AS database_name") {
      return { rows: [{ database_name: databaseName }], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { app: createApp({ query } as any,{ apnsMode }), query };
}

describe("browser candidate attestation", () => {
  test("fails closed before querying when the API flag is absent or inexact", async () => {
    for (const value of [undefined,"true","01"]) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
      const { app,query } = candidateApp("relo_browser");
      const response = await app.request("/health/browser-candidate-attestation");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
      expect(query).not.toHaveBeenCalled();
    }
  });

  test("fails closed when APNs is enabled or the database name is not exact", async () => {
    process.env[flag] = "1";
    const apnsEnabled = candidateApp("relo_browser","sandbox");
    expect((await apnsEnabled.app.request("/health/browser-candidate-attestation")).status).toBe(404);
    expect(apnsEnabled.query).not.toHaveBeenCalled();

    for (const databaseName of ["postgres","relo_browser_test","RELO_BROWSER"]) {
      const wrongDatabase = candidateApp(databaseName);
      const response = await wrongDatabase.app.request("/health/browser-candidate-attestation");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }

    const unavailable = createApp({ query: vi.fn(async () => { throw new Error("unavailable"); }) } as any,
      { apnsMode: "disabled" });
    expect((await unavailable.request("/health/browser-candidate-attestation")).status).toBe(404);
  });

  test("attests only the exact disabled-APNs disposable browser database", async () => {
    process.env[flag] = "1";
    const { app,query } = candidateApp("relo_browser");
    const response = await app.request("/health/browser-candidate-attestation");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ isolatedCandidate: true });
    expect(query).toHaveBeenCalledWith("SELECT current_database() AS database_name");
  });
});
