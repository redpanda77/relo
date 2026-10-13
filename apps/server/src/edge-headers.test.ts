import { describe, expect, test } from "vitest";
import { createApp, MAX_REQUEST_BODY_BYTES } from "./app.js";

const db = { query: async () => ({ rows: [] }) } as any;
function integrated(appUrl: string) {
  return createApp(db, { accountAuth: { api: {} } as any, bootstrapOwnerHandle: "owner",
    credentialDerivationSecret: "edge-headers-test-secret-0123456789abcdef", appUrl, apnsMode: "disabled" });
}

describe("public edge protections", () => {
  test("rejects request bodies above the server-wide limit before routing", async () => {
    const response = await createApp(db).request("/api/notifications", {
      method: "POST", headers: { "content-type": "application/json",
        "content-length": String(MAX_REQUEST_BODY_BYTES + 1) },
      body: "x".repeat(MAX_REQUEST_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
  });

  test("pins HTTPS for browsers only when the public origin is HTTPS", async () => {
    const https = await integrated("https://relo.example.com").request("/health/live");
    expect(https.headers.get("strict-transport-security")).toBe("max-age=31536000");
    const http = await integrated("http://127.0.0.1:8180").request("/health/live");
    expect(http.headers.get("strict-transport-security")).toBeNull();
  });
});
