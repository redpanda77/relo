import { ReloError, UsageError } from "../errors.mjs";
import { fromB64u, safetyNumber, verifyPrekey } from "../e2ee.mjs";
import { ensureIdentity, keyStorePath, saveKeyStore, trustKey, trustState } from "../keystore.mjs";
import { assertAllowedOptions, assertNoExtra, result, validateDeviceId } from "../support.mjs";

const USAGE = "Usage: relo keys status | relo keys verify DEVICE_ID | relo keys forget DEVICE_ID | relo keys rotate";
const PHONE_SCREEN = "Settings → Security on the iPhone";

function needsPerson(action) {
  return new ReloError(
    `relo keys ${action} needs a person at a terminal: the owner compares the safety number with ${PHONE_SCREEN}.`,
    { code: "PERSON_REQUIRED", exitCode: 2 },
  );
}

function deviceArgument(value) {
  if (!validateDeviceId(value)) throw new UsageError(USAGE, { hint: "Phone ids look like dev_…; relo keys status lists them" });
  return value;
}

async function loadIdentity(dependencies) {
  const path = keyStorePath(dependencies.configPath(), dependencies.env);
  const { store } = await ensureIdentity(path, { now: dependencies.now() });
  return { path, store };
}

/** Publishes this computer's identity key so the owner's phones can show the same safety number. */
async function publishIdentity(client, store) {
  await client.publishClientKey({ identityKey: store.identity.publicKey });
}

function describeDevice(store, apiUrl, device) {
  const prekeyOk = device.prekey && verifyPrekey({
    identityPublicKey: fromB64u(device.identityKey.publicKey, { length: 65 }),
    prekey: { ...device.prekey, deviceId: device.deviceId },
  });
  return {
    deviceId: device.deviceId,
    name: device.name,
    keyId: device.identityKey.keyId,
    trust: trustState(store, apiUrl, device),
    prekey: !device.prekey ? "missing" : !prekeyOk ? "invalid" : device.prekey.stale ? "stale" : "fresh",
  };
}

/** `relo keys`: this computer's encryption identity and the phones it trusts. */
export async function runKeysCommand(command) {
  const { options, group, action, rest, dependencies, client, config } = command;
  if (group !== "keys") return undefined;
  assertAllowedOptions(options, []);
  const apiUrl = config.apiUrl;

  if (action === "status") {
    assertNoExtra(rest, 0, USAGE);
    const { store } = await loadIdentity(dependencies);
    await publishIdentity(client, store);
    const { devices } = await client.listDeviceKeys();
    const described = devices.map((device) => describeDevice(store, apiUrl, device));
    const unverified = described.find((device) => device.trust !== "trusted");
    return result("keys.status", {
      identity: { keyId: store.identity.keyId, createdAt: store.identity.createdAt },
      devices: described,
      ...(unverified ? { next: `relo keys verify ${unverified.deviceId}` } : {}),
    });
  }

  if (action === "verify") {
    assertNoExtra(rest, 1, USAGE);
    const deviceId = deviceArgument(rest[0]);
    const { path, store } = await loadIdentity(dependencies);
    await publishIdentity(client, store);
    const { devices } = await client.listDeviceKeys();
    const device = devices.find((entry) => entry.deviceId === deviceId);
    if (!device) throw new UsageError(`No phone ${deviceId} has published encryption keys.`, { hint: "Open Relo on the iPhone, then run relo keys status" });
    const number = safetyNumber(fromB64u(store.identity.publicKey, { length: 65 }), fromB64u(device.identityKey.publicKey, { length: 65 }));
    const state = trustState(store, apiUrl, device);
    if (state === "trusted") return result("keys.verify", { deviceId, trust: "trusted", safetyNumber: number });
    if (!dependencies.stdinIsTTY || !dependencies.confirm) throw needsPerson("verify");
    dependencies.stderr?.(`Safety number for ${device.name} (${deviceId}):\n\n  ${number.replace(/((?:\d{5} ){5}\d{5}) /, "$1\n  ")}\n`);
    if (state === "changed") dependencies.stderr?.("Warning: this phone's key changed since you last verified it.");
    const same = await dependencies.confirm(`Does ${PHONE_SCREEN} show exactly this number? [y/N] `);
    if (!same) return result("keys.verify", { deviceId, trust: state, safetyNumber: number }, { message: "Not trusted. Nothing will be sealed to this phone." });
    store.trusted[trustKey(apiUrl, deviceId)] = {
      deviceId, name: device.name, keyId: device.identityKey.keyId, publicKey: device.identityKey.publicKey,
      verifiedAt: new Date(dependencies.now()).toISOString(),
    };
    await saveKeyStore(path, store);
    return result("keys.verify", { deviceId, trust: "trusted", safetyNumber: number });
  }

  if (action === "forget") {
    assertNoExtra(rest, 1, USAGE);
    const deviceId = deviceArgument(rest[0]);
    const { path, store } = await loadIdentity(dependencies);
    const removed = delete store.trusted[trustKey(apiUrl, deviceId)];
    await saveKeyStore(path, store);
    return result("keys.forget", { deviceId, removed });
  }

  if (action === "rotate") {
    assertNoExtra(rest, 0, USAGE);
    if (!dependencies.stdinIsTTY || !dependencies.confirm) throw needsPerson("rotate");
    const { path, store } = await loadIdentity(dependencies);
    const same = await dependencies.confirm("Replace this computer's encryption identity? Every phone must verify it again. [y/N] ");
    if (!same) return result("keys.rotate", { rotated: false, keyId: store.identity.keyId });
    const previous = store.identity.keyId;
    store.identity = null;
    await saveKeyStore(path, store);
    const { store: fresh } = await loadIdentity(dependencies);
    await publishIdentity(client, fresh);
    return result("keys.rotate", { rotated: true, previous, keyId: fresh.identity.keyId });
  }

  throw new UsageError(USAGE);
}
