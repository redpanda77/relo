import { generateKeyPairSync } from "node:crypto";
import { chmod,mkdtemp,rm,symlink,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ApnsProviderCleanroom, type ApnsTransport } from "./apns-provider-cleanroom.js";
import {
  cleanroomProviderConfig,
  readProtectedApnsPrivateKey,
  validateApnsWorkerConfig,
} from "./apns-runtime-config.js";
import { loadConfig } from "./config.js";

const privateKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey
  .export({ type: "pkcs8", format: "pem" }).toString();
const transport: ApnsTransport = { async open() { throw new Error("not used"); } };

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://test.invalid/relo",
    APNS_MODE: "sandbox",
    APNS_TEAM_ID: "TEAM123456",
    APNS_KEY_ID: "KEY1234567",
    APNS_TOPIC: "com.example.app",
    APNS_KEY_SCOPE: "team-scoped",
    APNS_KEY_ENVIRONMENT: "sandbox",
    APNS_CONFIGURATION_GENERATION: "candidate-1",
    ...overrides,
  };
}

describe("clean-room APNs runtime configuration", () => {
  test("strictly validates the optional non-secret release identity", () => {
    expect(loadConfig(env({ RELO_RELEASE_IDENTITY: " 0.2.0 " })).RELO_RELEASE_IDENTITY)
      .toBe("0.2.0");
    for (const value of ["", "<script>", "space separated", `v${"x".repeat(64)}`]) {
      expect(() => loadConfig(env({ RELO_RELEASE_IDENTITY: value }))).toThrow();
    }
  });

  test("accepts Compose's empty optional authorization fields while APNs is disabled", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://test.invalid/relo",
      APNS_MODE: "disabled",
      APNS_KEY_SCOPE: "",
      APNS_KEY_ENVIRONMENT: "",
      APNS_DUAL_ENVIRONMENT_CONFIRMED: "",
    });
    expect(config.APNS_KEY_SCOPE).toBeUndefined();
    expect(config.APNS_KEY_ENVIRONMENT).toBeUndefined();
    expect(config.APNS_DUAL_ENVIRONMENT_CONFIRMED).toBeUndefined();
  });

  test("builds an exact least-privilege topic configuration", () => {
    const built = cleanroomProviderConfig(loadConfig(env()), privateKey);
    expect(built).toMatchObject({
      environment: "sandbox",
      keyScope: "team-scoped",
      keyEnvironment: "sandbox",
      allowedTopics: ["com.example.app", "com.example.app.push-type.liveactivity"],
      bundleId: "com.example.app",
      configurationGeneration: "candidate-1",
      localConcurrencyCap: 32,
    });
    expect(() => new ApnsProviderCleanroom(built, transport)).not.toThrow();
  });

  test.each([
    "APNS_TEAM_ID", "APNS_KEY_ID", "APNS_TOPIC", "APNS_KEY_SCOPE",
    "APNS_KEY_ENVIRONMENT", "APNS_CONFIGURATION_GENERATION",
  ])("fails enabled startup when %s is absent", (name) => {
    const candidate = env();
    delete candidate[name];
    expect(() => cleanroomProviderConfig(loadConfig(candidate), privateKey)).toThrow(name);
  });

  test("requires authoritative topic associations for topic-specific keys", () => {
    const missing = cleanroomProviderConfig(loadConfig(env({ APNS_KEY_SCOPE: "topic-specific" })), privateKey);
    expect(() => new ApnsProviderCleanroom(missing, transport)).toThrow("appleAssociatedTopics");
    const configured = cleanroomProviderConfig(loadConfig(env({
      APNS_KEY_SCOPE: "topic-specific",
      APNS_ASSOCIATED_TOPICS: "com.example.app, com.example.app.push-type.liveactivity",
    })), privateKey);
    expect(() => new ApnsProviderCleanroom(configured, transport)).not.toThrow();
  });

  test("accepts dual-environment authorization only with explicit confirmation", () => {
    const unconfirmed = cleanroomProviderConfig(loadConfig(env({ APNS_KEY_ENVIRONMENT: "both" })), privateKey);
    expect(() => new ApnsProviderCleanroom(unconfirmed, transport)).toThrow("confirmed");
    const confirmed = cleanroomProviderConfig(loadConfig(env({
      APNS_KEY_ENVIRONMENT: "both",
      APNS_DUAL_ENVIRONMENT_CONFIRMED: "true",
    })), privateKey);
    expect(() => new ApnsProviderCleanroom(confirmed, transport)).not.toThrow();
  });

  test("rejects an enabled worker key/environment mismatch without endpoint fallback", () => {
    const mismatched = cleanroomProviderConfig(loadConfig(env({ APNS_KEY_ENVIRONMENT: "production" })), privateKey);
    expect(() => new ApnsProviderCleanroom(mismatched, transport)).toThrow("not authorized");
  });

  test("validates the protected worker boundary before reading a credential", () => {
    const now = new Date("2026-08-07T12:00:00.000Z");
    const configured = loadConfig(env({
      APNS_KEY_FILE: "/run/secrets/apns_key.p8",
      APNS_CUTOVER_AT: "2026-08-07T11:59:00.000Z",
    }));
    expect(validateApnsWorkerConfig(configured,now)).toEqual({
      cutoverAt: new Date("2026-08-07T11:59:00.000Z"),
      configurationGeneration: "candidate-1",
    });
    expect(() => validateApnsWorkerConfig(loadConfig(env({
      APNS_KEY_FILE: "/run/secrets/apns_key.p8",
      APNS_CUTOVER_AT: "2026-08-07T12:00:00.001Z",
    })),now)).toThrow("future");
    expect(() => validateApnsWorkerConfig(loadConfig(env({
      APNS_CUTOVER_AT: "2026-08-07T11:59:00.000Z",
    })),now)).toThrow("APNS_KEY_FILE");
  });

  test("rejects malformed protected identifiers, topics, and association lists", () => {
    for (const overrides of [
      { APNS_TEAM_ID: "short" },
      { APNS_KEY_ID: "key-with-dash" },
      { APNS_CONFIGURATION_GENERATION: "generation with spaces" },
    ]) expect(() => loadConfig(env(overrides))).toThrow();
    expect(() => cleanroomProviderConfig(loadConfig(env({ APNS_TOPIC: "com..example" })),privateKey))
      .toThrow("APNS_TOPIC");
    expect(() => cleanroomProviderConfig(loadConfig(env({
      APNS_ASSOCIATED_TOPICS: "com.example.app,com.example.app",
    })),privateKey)).toThrow("unique");
  });

  test("reads only a bounded regular mode-0600 PKCS#8 key file", async () => {
    const directory = await mkdtemp(join(tmpdir(),"relo-apns-key-"));
    try {
      const keyPath = join(directory,"key.p8");
      await writeFile(keyPath,privateKey,{ mode: 0o600 });
      const configured = loadConfig(env({ APNS_KEY_FILE: keyPath }));
      await expect(readProtectedApnsPrivateKey(configured)).resolves.toBe(privateKey.trim());
      await chmod(keyPath,0o644);
      await expect(readProtectedApnsPrivateKey(configured)).rejects.toThrow("unsafe metadata");
      await chmod(keyPath,0o600);
      const linkPath = join(directory,"linked.p8");
      await symlink(keyPath,linkPath);
      await expect(readProtectedApnsPrivateKey(loadConfig(env({ APNS_KEY_FILE: linkPath }))))
        .rejects.toThrow("Protected APNs key file");
    } finally {
      await rm(directory,{ recursive: true,force: true });
    }
  });
});
