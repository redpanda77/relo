import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { deliveryGuard } from "../src/messages/delivery.mjs";

test("a delivery read only by Relo for Mac counts as delivered; nothing at all is still no delivery", () => {
  const macOnly = { eventId: "e1", delivery: { eligibleDevices: 0, durableCommands: 0, apnsJobs: 0, readers: 1 } };
  assert.equal(deliveryGuard(macOnly), macOnly);
  assert.throws(() => deliveryGuard({ eventId: "e2", delivery: { eligibleDevices: 0, durableCommands: 0, apnsJobs: 0 } }),
    (error) => error.name === "NoDeliveryError" || error.code === "NO_DELIVERY" || /no/i.test(error.message));
  const phone = { eventId: "e3", delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 } };
  assert.equal(deliveryGuard(phone), phone);
});
