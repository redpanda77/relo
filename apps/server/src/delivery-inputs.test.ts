import { expect, test } from "vitest";
import { pinOrdinaryDeliveryInputs } from "./delivery-inputs.js";

test("retry uses its original badge and avatar without reading changing account state", async () => {
  const original = { badge: 2,avatarUrl: "https://example.com/original.png" };
  const db = { query: async () => { throw new Error("unexpected write"); } };
  expect(await pinOrdinaryDeliveryInputs(db as never,{ id: "job",claim_token: "claim",ordinary_delivery_inputs: original },async () => {
    throw new Error("must not recalculate badge or avatar");
  })).toEqual(original);
});

test("a legacy payload pin without its inputs is rejected without changing hashes", async () => {
  const queries: string[] = [];
  const db = { query: async (sql: string) => {
    queries.push(sql);
    return sql.startsWith("SELECT") ? { rowCount: 1,rows: [{}] } : { rowCount: 0,rows: [] };
  } };
  await expect(pinOrdinaryDeliveryInputs(db as never,{ id: "job",claim_token: "claim",ordinary_delivery_inputs: null },async () => ({ badge: 9,avatarUrl: null })))
    .rejects.toThrow("serialization evidence changed");
  expect(queries.join("\n")).not.toMatch(/SET\s+(apns_payload_sha256|device_projection_sha256)/);
});
