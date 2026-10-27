import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ApiError, EXIT, EXIT_CODES, NetworkError } from "../src/shared/errors.mjs";
import { HELP } from "../src/help.mjs";
import { run } from "../src/cli.mjs";

const CONFIG = {
  apiUrl: "https://server.example.test",
  token: `klb_${"x".repeat(44)}`,
  path: "/private/config.json",
  principal: { id: "prn_test", scopes: ["notifications:send", "interactions:read"] },
};

function dependencies(client) {
  return {
    configPath: () => CONFIG.path,
    loadConfig: async () => CONFIG,
    clientFactory: () => client,
  };
}

test("publishes the golden exit-code matrix (0.11: 4 still open, 8 closed)", async () => {
  assert.deepEqual(EXIT, {
    OK: 0,
    USAGE: 2,
    API: 1,
    AUTH: 3,
    TERMINAL: 4,
    NEGATIVE: 5,
    NETWORK: 6,
    NO_DELIVERY: 7,
    CLOSED: 8,
  });
  // Help renders the one table (EXIT_CODES), so every code appears with its meaning, in order.
  assert.ok(HELP.includes(EXIT_CODES.map(({ code, meaning }) => `  ${code} ${meaning}`).join("\n")));
  const cliReadme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const skillReference = readFileSync(
    new URL("../../../skills/relo-notifications/references/cli.md", import.meta.url),
    "utf8",
  );
  for (const document of [cliReadme, skillReference]) {
    assert.match(document, /\| `1` \| Server or other failure/u);
    assert.match(document, /\| `3` \| Missing, invalid, or insufficient credential/u);
    assert.match(document, /\| `4` \| Still open: this command stopped waiting\. Run `relo interaction wait ID`/u);
    assert.match(document, /\| `8` \| Closed without an answer \(expired, canceled\): do not act/u);
    assert.match(document, /\| `5` \| The owner denied or said no/u);
    assert.match(document, /\| `6` \| Network unreachable/u);
    assert.match(document, /\| `7` \| Nothing could show it/u);
  }

  const cases = [
    {
      name: "API or other failure",
      argv: ["devices", "list"],
      client: { listDevices: async () => { throw new ApiError("failed", { status: 500 }); } },
      expectedExit: 1,
      expectedError: "API_ERROR",
    },
    {
      name: "usage",
      argv: ["unknown"],
      client: {},
      expectedExit: 2,
      expectedError: "USAGE_ERROR",
    },
    {
      name: "authentication or scope",
      argv: ["devices", "list"],
      client: {
        listDevices: async () => {
          throw new ApiError("unauthorized", { status: 401, code: "UNAUTHORIZED" });
        },
      },
      expectedExit: 3,
      expectedError: "UNAUTHORIZED",
    },
    {
      name: "closed without an answer (expired)",
      argv: ["interaction", "wait", "int_golden_123456", "--timeout", "1s"],
      client: {
        waitForInteraction: async () => ({
          interaction: { id: "int_golden_123456", state: "expired" },
        }),
      },
      expectedExit: 8,
      expectedError: "INTERACTION_CLOSED",
    },
    {
      name: "still open when the wait runs out",
      argv: ["interaction", "wait", "int_golden_123456", "--timeout", "1s"],
      client: {
        waitForInteraction: async () => ({
          interaction: { id: "int_golden_123456", state: "pending" },
        }),
      },
      expectedExit: 4,
      expectedError: "INTERACTION_TERMINAL",
    },
    {
      name: "denied or no",
      argv: ["interaction", "wait", "int_golden_123456", "--timeout", "1s"],
      client: {
        waitForInteraction: async () => ({
          interaction: { id: "int_golden_123456", state: "denied" },
        }),
      },
      expectedExit: 5,
      expectedError: "NEGATIVE_RESPONSE",
    },
    {
      name: "network",
      argv: ["devices", "list"],
      client: { listDevices: async () => { throw new NetworkError("offline"); } },
      expectedExit: 6,
      expectedError: "NETWORK_ERROR",
    },
    {
      name: "no accepted device",
      argv: ["notify", "send", "Done", "--source", "Test", "--project", "Checks", "--topic", "Exit codes"],
      client: {
        sendNotification: async () => ({
          eventId: "ntf_golden_123456",
          eligibleDevices: 1,
          durableCommands: 0,
          apnsJobs: 0,
        }),
      },
      expectedExit: 7,
      expectedError: "NO_ACCEPTED_DELIVERY",
    },
  ];

  for (const entry of cases) {
    const stdout = [];
    const stderr = [];
    const exitCode = await run(
      [...entry.argv, "--json"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      dependencies(entry.client),
    );
    assert.equal(exitCode, entry.expectedExit, entry.name);
    assert.equal(stdout.length, 1, entry.name);
    assert.equal(JSON.parse(stdout[0]).error.code, entry.expectedError, entry.name);
    assert.equal(stderr.length, 0, entry.name);
  }
});
