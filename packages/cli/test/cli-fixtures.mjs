// Shared fixtures of the cli-*.test.mjs files: the grouped test identity, the fake config and client
// overrides, and the login and delivery fixtures.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute as executeRaw, run as runRaw } from "../src/cli.mjs";
import { noRunningCards } from "./fake-cards.mjs";

// Existing behavioral tests use an explicitly grouped fixture; identity omissions have dedicated
// tests against the raw entry point below.
const TEST_IDENTITY = { providerName: "Test source",project: "Test project",threadName: "Test topic" };
export function testContext(patch = {}) {
  const context = { ...TEST_IDENTITY,...patch };
  return { ...context,providerThreadId: `cli-topic:${createHash("sha256")
    .update(JSON.stringify([context.providerName,context.project,context.threadName])).digest("hex")}` };
}
function groupedArgs(argv, dependencies) {
  const creates = argv[0] === "notify" && argv[1] !== "withdraw";
  if (!creates || argv.includes("--help")) return [argv,dependencies];
  if (argv.includes("--stdin")) {
    const read = dependencies.readStdinJson;
    if (!read) return [argv,dependencies];
    return [argv,{ ...dependencies,readStdinJson: async () => {
      const input = await read();
      return input.origin ? input : { ...input,context: { ...TEST_IDENTITY,...input.context } };
    } }];
  }
  const args = [...argv];
  for (const [flag,key] of [["--source","providerName"],["--project","project"],["--topic","threadName"]]) {
    if (!args.includes(flag) && !(flag === "--topic" && args.includes("--thread-name"))) args.splice(args.includes("--") ? args.indexOf("--") : args.length,0,flag,TEST_IDENTITY[key]);
  }
  return [args,dependencies];
}
// The computer a test runs on is not part of what these tests pin; origin has its own tests.
const NO_ORIGIN = { originDefaults: () => ({}) };
// A sign-in makes the computer's identity key before it starts, so `auth login` gets its own throwaway key store;
// every other command keeps the unwritable one from hermetic-env.mjs (a key would turn opaque names on).
export const loginKeyStoreEnv = () => ({ RELO_KEY_STORE_PATH: join(mkdtempSync(join(tmpdir(), "relo-login-keys-")), "e2ee.json") });
function withLoginKeyStore(argv, dependencies) {
  if (argv[0] !== "auth" || argv[1] !== "login") return dependencies;
  const env = dependencies.env ?? process.env;
  if (env.RELO_KEY_STORE_PATH && !env.RELO_KEY_STORE_PATH.startsWith(process.env.RELO_TEST_UNWRITABLE)) return dependencies;
  return { ...dependencies, env: { ...env, ...loginKeyStoreEnv() } };
}
export function execute(argv, dependencies = {}) {
  return executeRaw(...groupedArgs(argv,{ ...NO_ORIGIN,...withLoginKeyStore(argv,dependencies) }));
}
export function run(argv, io, dependencies = {}) {
  const [args, grouped] = groupedArgs(argv,{ ...NO_ORIGIN,...withLoginKeyStore(argv,dependencies) });
  return runRaw(args,io,grouped);
}

export const CONFIG = {
  apiUrl: "https://server.example.test",
  token: `klb_${"x".repeat(44)}`,
  path: "/private/config.json",
  principal: {
    id: "prn_test",
    scopes: ["notifications:send", "interactions:create", "interactions:read"],
  },
};

export function overrides(client) {
  return {
    // These parsing/presentation fixtures stub the capture port. The raw CLI
    // durability/retry tests exercise the real file store in an isolated directory.
    captureActivityCommand: async ({ body }) => ({ target: null,ifSequence: body.ifSequence }),
    prepareNotificationCommand: async ({ body }) => body,
    configPath: () => CONFIG.path,
    loadConfig: async () => CONFIG,
    clientFactory: () => noRunningCards(client),
  };
}

export const LOGIN_SCOPES = ["interactions:create", "interactions:read", "notifications:send"];
export const DEVICE_CODE = "d".repeat(43);
export const ACCESS_TOKEN = `relo_${"s".repeat(43)}`;
export const TARGET_DEVICE = "dev_123456789012";
export const WAIT_EVENT = "ntf_44444444-4444-4444-8444-444444444444";
export const DELIVERY_JOB = "job_55555555-5555-4555-8555-555555555555";
export const DELIVERY = { eligibleDevices: 1, durableCommands: 1, apnsJobs: 0 };
export const CONTRACT_FIXTURE = JSON.parse(
  // The CLI refuses placeholder statuses ("Starting"); the frozen shape is what this test pins.
  readFileSync(new URL("../../contracts/fixtures/current-slice.json", import.meta.url), "utf8").replace('"status": "Starting"', '"status": "Loading fixtures"'),
);
export const EVIDENCE_FIXTURE = JSON.parse(
  readFileSync(new URL("../../contracts/fixtures/delivery-evidence-v1.json", import.meta.url), "utf8"),
);

export function authorizationStart(overrides = {}) {
  return {
    deviceCode: DEVICE_CODE,
    userCode: "ABCD-EFGH",
    verificationUri: "http://192.168.1.10:8180/cli/authorize",
    verificationUriComplete: "http://192.168.1.10:8180/cli/authorize?code=ABCD-EFGH",
    expiresInSeconds: 600,
    intervalSeconds: 5,
    ...overrides,
  };
}

export function issuedCredential(overrides = {}) {
  return {
    accessToken: ACCESS_TOKEN,
    credential: {
      id: "key_0123456789ab",
      clientName: "Mac Codex",
      prefix: "relo_ssss",
      scopes: LOGIN_SCOPES,
      createdAt: "2026-08-06T12:00:00.000Z",
      expiresAt: "2026-11-04T12:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    },
    ...overrides,
  };
}
