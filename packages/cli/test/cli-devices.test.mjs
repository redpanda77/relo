import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, EXIT } from "../src/shared/errors.mjs";
import { execute, overrides, TARGET_DEVICE, DELIVERY } from "./cli-fixtures.mjs";

test("devices list enumerates every page without changing its output contract", async () => {
  const calls = [];
  const first = { deviceId: "dev_111111111111", name: "First" };
  const second = { deviceId: "dev_222222222222", name: "Second" };
  const third = { deviceId: "dev_333333333333", name: "Third" };
  const client = {
    listDevices: async (options) => {
      calls.push(options);
      if (options.cursor === undefined) {
        return { devices: [first, second], cursor: "page-two", hasMore: true };
      }
      return { devices: [third], cursor: null, hasMore: false };
    },
  };
  const output = await execute(["devices", "list", "--page-size", "2"], overrides(client));
  assert.equal(output.command, "devices.list");
  assert.deepEqual(output.data, { devices: [first, second, third] });
  assert.deepEqual(calls, [
    { limit: 2 },
    { limit: 2, cursor: "page-two" },
  ]);

  await assert.rejects(
    execute(["devices", "list", "--page-size", "0"], overrides(client)),
    /at least 1/,
  );
  await assert.rejects(
    execute(["devices", "list", "--page-size", "101"], overrides(client)),
    /at most 100/,
  );
});

test("device pagination fails closed on malformed pages, duplicates, loops, and excessive pages", async () => {
  const valid = { deviceId: "dev_111111111111" };
  for (const response of [
    undefined,
    {},
    { devices: "invalid", cursor: null, hasMore: false },
    { devices: [{ deviceId: "invalid" }], cursor: null, hasMore: false },
    { devices: [valid] },
    { devices: [valid], hasMore: false },
    { devices: [valid], cursor: null },
    { devices: [valid], cursor: null, hasMore: true },
    { devices: [valid], cursor: "next", hasMore: false },
    { devices: [], cursor: "next", hasMore: true },
  ]) {
    await assert.rejects(
      execute(["devices", "list"], overrides({ listDevices: async () => response })),
      (error) => error.code === "INVALID_API_RESPONSE",
    );
  }

  await assert.rejects(
    execute(["devices", "list"], overrides({
      listDevices: async ({ cursor }) => cursor === undefined
        ? { devices: [valid], cursor: "again", hasMore: true }
        : { devices: [{ deviceId: "dev_222222222222" }], cursor: "again", hasMore: true },
    })),
    (error) => error.code === "INVALID_API_RESPONSE",
  );
  await assert.rejects(
    execute(["devices", "list"], overrides({
      listDevices: async ({ cursor }) => cursor === undefined
        ? { devices: [valid], cursor: "next", hasMore: true }
        : { devices: [valid], cursor: null, hasMore: false },
    })),
    (error) => error.code === "INVALID_API_RESPONSE",
  );

  let pages = 0;
  await assert.rejects(
    execute(["devices", "list", "--page-size", "1"], overrides({
      listDevices: async () => {
        pages += 1;
        return {
          devices: [{ deviceId: `dev_${String(pages).padStart(12, "0")}` }],
          cursor: `page-${pages}`,
          hasMore: true,
        };
      },
    })),
    (error) => error.code === "INVALID_API_RESPONSE",
  );
  assert.equal(pages, 100);
});

test("target validation reaches later pages and preserves authentication and cursor failures", async () => {
  const target = "dev_999999999999";
  let sent;
  const output = await execute(["notify", "send", "Done", "--device", target], overrides({
    listDevices: async ({ cursor }) => cursor === undefined
      ? { devices: [{ deviceId: "dev_111111111111" }], cursor: "next", hasMore: true }
      : { devices: [{ deviceId: target }], cursor: null, hasMore: false },
    sendNotification: async (body) => { sent = body; return DELIVERY; },
  }));
  assert.equal(output.exitCode, EXIT.OK);
  assert.deepEqual(sent.deviceIds, [target]);

  for (const failure of [
    new ApiError("unauthorized", { status: 401, code: "UNAUTHORIZED" }),
    new ApiError("cursor_expired", { status: 410, code: "CURSOR_EXPIRED" }),
  ]) {
    await assert.rejects(
      execute(["devices", "list"], overrides({ listDevices: async () => { throw failure; } })),
      (error) => error === failure,
    );
  }
});

test("rejects malformed and unknown target devices before a mutation", async () => {
  let listed = 0;
  let mutated = 0;
  const client = {
    listDevices: async () => {
      listed += 1;
      return { devices: [{ deviceId: TARGET_DEVICE }], cursor: null, hasMore: false };
    },
    sendNotification: async () => {
      mutated += 1;
      return DELIVERY;
    },
  };
  await assert.rejects(
    execute(["notify", "send", "Done", "--device", "dev_bad"], overrides(client)),
    /Malformed target device/,
  );
  assert.equal(listed, 0);
  await assert.rejects(
    execute(
      ["notify", "send", "Done", "--device", "dev_999999999999"],
      overrides(client),
    ),
    /Unknown target device/,
  );
  assert.equal(listed, 1);
  assert.equal(mutated, 0);
});
