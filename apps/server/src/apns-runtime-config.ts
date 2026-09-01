import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ApnsProviderConfig } from "./apns-provider-cleanroom.js";
import type { Config } from "./config.js";

export type ValidatedApnsWorkerConfig = {
  cutoverAt: Date;
  configurationGeneration: string;
};

export function validateApnsWorkerConfig(
  config: Config,
  now: Date = new Date(),
): ValidatedApnsWorkerConfig {
  if (config.APNS_MODE === "disabled") {
    throw new Error("APNs worker configuration requires an enabled environment");
  }
  if (!config.APNS_CUTOVER_AT) throw new Error("APNS_CUTOVER_AT is required when APNs is enabled");
  const cutoverAt = new Date(config.APNS_CUTOVER_AT);
  if (!Number.isFinite(cutoverAt.getTime()) || cutoverAt.getTime() > now.getTime()) {
    throw new Error("APNS_CUTOVER_AT must be a valid boundary that is not in the future");
  }
  const generation = required(config.APNS_CONFIGURATION_GENERATION,"APNS_CONFIGURATION_GENERATION");
  required(config.APNS_KEY_FILE,"APNS_KEY_FILE");
  const topic = required(config.APNS_TOPIC,"APNS_TOPIC");
  if (!validTopic(topic)) throw new Error("APNS_TOPIC is invalid");
  return { cutoverAt,configurationGeneration: generation };
}

export async function readProtectedApnsPrivateKey(config: Config): Promise<string> {
  const path = required(config.APNS_KEY_FILE,"APNS_KEY_FILE");
  let handle;
  try {
    handle = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error("Protected APNs key file is unavailable");
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0
      || metadata.size < 1 || metadata.size > 16_384) {
      throw new Error("Protected APNs key file has unsafe metadata");
    }
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await handle.read(buffer,0,buffer.length,0);
    if (bytesRead < 1 || bytesRead > 16_384) {
      throw new Error("Protected APNs key file has unsafe metadata");
    }
    const value = buffer.subarray(0,bytesRead).toString("utf8").trim();
    if (!/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----$/.test(value)) {
      throw new Error("Protected APNs key file is not a PKCS#8 private key");
    }
    return value;
  } finally {
    await handle.close();
  }
}

export function cleanroomProviderConfig(config: Config, privateKeyPem: string): ApnsProviderConfig {
  if (config.APNS_MODE === "disabled") throw new Error("APNs provider configuration requires an enabled environment");
  const teamId = required(config.APNS_TEAM_ID, "APNS_TEAM_ID");
  const keyId = required(config.APNS_KEY_ID, "APNS_KEY_ID");
  const bundleId = required(config.APNS_TOPIC, "APNS_TOPIC");
  if (!validTopic(bundleId)) throw new Error("APNS_TOPIC is invalid");
  const keyScope = config.APNS_KEY_SCOPE;
  if (!keyScope) throw new Error("APNS_KEY_SCOPE is required when APNs is enabled");
  const keyEnvironment = config.APNS_KEY_ENVIRONMENT;
  if (!keyEnvironment) throw new Error("APNS_KEY_ENVIRONMENT is required when APNs is enabled");
  const configurationGeneration = required(
    config.APNS_CONFIGURATION_GENERATION,
    "APNS_CONFIGURATION_GENERATION",
  );
  const topics = [bundleId, `${bundleId}.push-type.liveactivity`];
  const appleAssociatedTopics = csv(config.APNS_ASSOCIATED_TOPICS);
  return {
    teamId,
    keyId,
    privateKeyPem,
    keyScope,
    keyEnvironment,
    ...(config.APNS_DUAL_ENVIRONMENT_CONFIRMED === undefined
      ? {}
      : { dualEnvironmentConfirmed: config.APNS_DUAL_ENVIRONMENT_CONFIRMED }),
    ...(appleAssociatedTopics === undefined ? {} : { appleAssociatedTopics }),
    allowedTopics: topics,
    bundleId,
    environment: config.APNS_MODE,
    configurationGeneration,
    localConcurrencyCap: config.APNS_LOCAL_CONCURRENCY_CAP,
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required when APNs is enabled`);
  return value;
}

function csv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const topics = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!topics.length || topics.some((item) => !validTopic(item)) || new Set(topics).size !== topics.length) {
    throw new Error("APNS_ASSOCIATED_TOPICS must be a unique comma-separated topic list");
  }
  return topics;
}

function validTopic(value: string): boolean {
  return value.length <= 255
    && /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
    && !value.includes("..");
}
