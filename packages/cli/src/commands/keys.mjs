import { ReloError, UsageError } from "../errors.mjs";
import { fromB64u, safetyNumber, verifyPrekey } from "../e2ee.mjs";
import { ensureIdentity, keyStorePath, saveKeyStore, trustKey, trustState } from "../keystore.mjs";
import { ensureTrust } from "../trust.mjs";
import { assertAllowedOptions, assertNoExtra, result, validateDeviceId } from "../support.mjs";

const USAGE = "Usage: relo keys status | relo keys verify DEVICE_ID | relo keys forget DEVICE_ID | relo keys rotate"
  + " | relo keys require on|auto|off | relo keys strict on|off";
const PHONE_SCREEN = "Settings → Security → Verify security code on the iPhone";

function needsPerson(action) {
  return new ReloError(
    `relo keys ${action} needs a person at a terminal.`,
    { code: "PERSON_REQUIRED", exitCode: 2 },
  );
}

function deviceArgument(value) {
  if (!validateDeviceId(value)) throw new UsageError(USAGE, { hint: "Phone ids look like dev_…; relo keys status lists them" });
  return value;
}

function storePath(dependencies) {
  return keyStorePath(dependencies.configPath(), dependencies.env);
}

function describeDevice(store, apiUrl, device) {
  const pinned = store.trusted[trustKey(apiUrl, device.deviceId)];
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
    ...(pinned?.notice ? { notice: pinned.notice } : {}),
  };
}

/** `relo keys`: this computer's encryption identity and the phones it seals for (trusted automatically). */
export async function runKeysCommand(command) {
  const { options, group, action, rest, dependencies, client, config } = command;
  if (group !== "keys") return undefined;
  assertAllowedOptions(options, []);
  const apiUrl = config.apiUrl;

  if (action === "status") {
    assertNoExtra(rest, 0, USAGE);
    const { store, devices } = await ensureTrust({ client, config, dependencies });
    // An older server has no policy route; status still reports the keys.
    let policy = null;
    try {
      policy = await client.endToEndPolicy();
    } catch {}
    return result("keys.status", {
      identity: { keyId: store.identity.keyId, createdAt: store.identity.createdAt },
      required: policy?.required === true,
      strict: store.strict === true,
      devices: devices.filter((device) => device?.identityKey).map((device) => describeDevice(store, apiUrl, device)),
    });
  }

  if (action === "verify") {
    // Optional: comparing safety numbers upgrades an automatically trusted phone to "verified".
    assertNoExtra(rest, 1, USAGE);
    const deviceId = deviceArgument(rest[0]);
    const { store, devices } = await ensureTrust({ client, config, dependencies });
    const device = devices.find((entry) => entry.deviceId === deviceId);
    if (!device) throw new UsageError(`No phone ${deviceId} has published encryption keys.`, { hint: "Open Relo on the iPhone, then run relo keys status" });
    const number = safetyNumber(fromB64u(store.identity.publicKey, { length: 65 }), fromB64u(device.identityKey.publicKey, { length: 65 }));
    const state = trustState(store, apiUrl, device);
    if (state === "verified") return result("keys.verify", { deviceId, trust: "verified", safetyNumber: number });
    if (!dependencies.stdinIsTTY || !dependencies.confirm) throw needsPerson("verify");
    dependencies.stderr?.(`Security code for ${device.name} (${deviceId}):\n\n  ${number.replace(/((?:\d{5} ){5}\d{5}) /, "$1\n  ")}\n`);
    const same = await dependencies.confirm(`Does ${PHONE_SCREEN} show exactly this number? [y/N] `);
    if (!same) return result("keys.verify", { deviceId, trust: state, safetyNumber: number }, { message: "Not marked verified." });
    store.trusted[trustKey(apiUrl, deviceId)] = {
      deviceId, name: device.name, keyId: device.identityKey.keyId, publicKey: device.identityKey.publicKey,
      level: "verified", trustedAt: new Date(dependencies.now()).toISOString(),
    };
    await saveKeyStore(storePath(dependencies), store);
    return result("keys.verify", { deviceId, trust: "verified", safetyNumber: number });
  }

  if (action === "forget") {
    assertNoExtra(rest, 1, USAGE);
    const deviceId = deviceArgument(rest[0]);
    const { store } = await ensureIdentity(storePath(dependencies), { now: dependencies.now() });
    const removed = delete store.trusted[trustKey(apiUrl, deviceId)];
    await saveKeyStore(storePath(dependencies), store);
    return result("keys.forget", { deviceId, removed });
  }

  if (action === "rotate") {
    assertNoExtra(rest, 0, USAGE);
    if (!dependencies.stdinIsTTY || !dependencies.confirm) throw needsPerson("rotate");
    const { store } = await ensureIdentity(storePath(dependencies), { now: dependencies.now() });
    const same = await dependencies.confirm("Replace this computer's encryption identity? Phones show a security code change. [y/N] ");
    if (!same) return result("keys.rotate", { rotated: false, keyId: store.identity.keyId });
    const previous = store.identity.keyId;
    store.identity = null;
    store.published = {};
    await saveKeyStore(storePath(dependencies), store);
    const { store: fresh } = await ensureTrust({ client, config, dependencies });
    return result("keys.rotate", { rotated: true, previous, keyId: fresh.identity.keyId });
  }

  if (action === "require") {
    // Turning protection on (or back to automatic) needs nobody; turning it off needs the owner.
    assertNoExtra(rest, 1, USAGE);
    const value = { on: true, auto: null, off: false }[rest[0]];
    if (value === undefined) throw new UsageError(USAGE);
    if (value === false) {
      if (!dependencies.stdinIsTTY || !dependencies.confirm) throw needsPerson("require off");
      if (!(await dependencies.confirm("Allow readable notices, questions and cards from CLIs again? [y/N] "))) {
        return result("keys.require", { changed: false });
      }
    }
    const policy = await client.setEndToEndPolicy(value);
    return result("keys.require", { required: policy.required === true, mode: rest[0], changed: true });
  }

  if (action === "strict") {
    // Strict mode: a phone whose security code changes is not sealed to until verified again.
    assertNoExtra(rest, 1, USAGE);
    if (!["on", "off"].includes(rest[0])) throw new UsageError(USAGE);
    if (!dependencies.stdinIsTTY || !dependencies.confirm) throw needsPerson(`strict ${rest[0]}`);
    const { store } = await ensureIdentity(storePath(dependencies), { now: dependencies.now() });
    const question = rest[0] === "on"
      ? "Stop sealing to a phone whose security code changes until you verify it again? [y/N] "
      : "Trust changed security codes automatically again? [y/N] ";
    if (!(await dependencies.confirm(question))) return result("keys.strict", { strict: store.strict === true, changed: false });
    store.strict = rest[0] === "on";
    await saveKeyStore(storePath(dependencies), store);
    return result("keys.strict", { strict: store.strict, changed: true });
  }

  throw new UsageError(USAGE);
}
