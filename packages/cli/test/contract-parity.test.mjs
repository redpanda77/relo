import "./hermetic-env.mjs";
// The CLI validates relevance itself so it can stay dependency-free. This test holds that
// validation to the shared contract: both must accept and reject exactly the same policies.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { notificationRelevance } from "../src/relevance.mjs";

const contractsUrl = new URL("../../contracts/dist/src/relevance.js", import.meta.url);

const at = "2026-10-06T12:00:00Z";
const policies = [
  { kind: "notice" },
  { kind: "notice", relevanceSeconds: 600 },
  { kind: "notice", relevanceSeconds: 600, deliverySeconds: 60 },
  { kind: "notice", relevanceSeconds: 60, deliverySeconds: 600 },
  { kind: "notice", relevanceSeconds: 0 },
  { kind: "notice", relevanceSeconds: 1.5 },
  { kind: "notice", unknown: true },
  { kind: "decision" },
  { kind: "decision", actionSeconds: 300 },
  { kind: "decision", actionSeconds: 300, deliverySeconds: 600 },
  { kind: "decision", actionSeconds: 300, deliverySeconds: 60 },
  { kind: "progress" },
  { kind: "progress", heartbeat: { intervalSeconds: 30, lastHeartbeatAt: at } },
  { kind: "progress", heartbeat: { intervalSeconds: 0, lastHeartbeatAt: at } },
  { kind: "progress", heartbeat: { intervalSeconds: 30, lastHeartbeatAt: "yesterday" } },
  { kind: "progress", heartbeat: { intervalSeconds: 30 } },
  { kind: "incident", mode: "until_resolved" },
  { kind: "incident", mode: "until_resolved", leaseUntil: at },
  { kind: "incident", mode: "lease", leaseUntil: at },
  { kind: "incident", mode: "lease" },
  { kind: "incident", mode: "forever" },
  { kind: "other" },
];

test("CLI relevance policy validation agrees with the shared contract", { skip: !existsSync(contractsUrl) && "build @relo/notification-contracts first" }, async () => {
  const { relevancePolicySchema } = await import(contractsUrl.href);
  for (const policy of policies) {
    const contract = relevancePolicySchema.safeParse(policy).success;
    const kind = policy.kind === "decision" ? "decision" : "notice";
    let cli = true;
    try {
      notificationRelevance({ subjectKey: "parity", generation: 1, revision: 1, operation: "replace", occurredAt: at, policy },
        kind, policy.actionSeconds ?? 900);
    } catch {
      cli = false;
    }
    assert.equal(cli, contract, `${JSON.stringify(policy)}: CLI ${cli ? "accepts" : "rejects"}, contract ${contract ? "accepts" : "rejects"}`);
  }
});
