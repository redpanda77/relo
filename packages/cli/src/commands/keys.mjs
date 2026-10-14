import { ReloError, UsageError } from "../errors.mjs";
import { fromB64u, safetyNumber, verifyPrekey } from "../e2ee.mjs";
import { ensureIdentity, keyStorePath, saveKeyStore, trustKey, trustState } from "../keystore.mjs";
import { ensureTrust, trustedPhones, trustedPhonesLabel, trustNotices } from "../trust.mjs";
import { isSimulator, matchPhones, modelName, phoneHandle, phoneLabel } from "../device-names.mjs";
import { assertAllowedOptions, assertNoExtra, result, validateDeviceId } from "../support.mjs";

const USAGE = "Usage: relo keys status | relo keys approve PHONE [--yes] | relo keys remove PHONE | relo keys verify DEVICE_ID"
  + " | relo keys forget DEVICE_ID | relo keys rotate | relo keys require on|auto|off | relo keys strict on|off";
const PHONE_SCREEN = "Settings → Security → Verify security code on the iPhone";
const DASHBOARD_REMOVE = "Dashboard → Account → Security → Devices → Remove";

function needsPerson(action, hint) {
  return new ReloError(
    `relo keys ${action} needs a person at a terminal.`,
    { code: "PERSON_REQUIRED", exitCode: 2, ...(hint ? { details: { hint } } : {}) },
  );
}

function deviceArgument(value) {
  if (!validateDeviceId(value)) throw new UsageError(USAGE, { hint: "Phone ids look like dev_…; relo keys status lists them" });
  return value;
}

function storePath(dependencies) {
  return keyStorePath(dependencies.configPath(), dependencies.env);
}

/** Phones in the key listing, named the way the owner knows them (the pinned name when the listing has none). */
function listedPhones(store, apiUrl, devices) {
  return devices.filter((device) => device?.identityKey && device.kind !== "browser" && device.deviceId?.startsWith("dev_"))
    .map((device) => ({ ...device, name: device.name ?? store.trusted[trustKey(apiUrl, device.deviceId)]?.name }));
}

/** The one phone `query` (a dev_ id, or a name/model like iphone-air) names, or a usage error saying which exist. */
function findPhone(query, phones) {
  const matches = matchPhones(query, phones);
  const known = phones.map((device) => `${phoneHandle(device, phones)} (${phoneLabel(device)})`).join(", ");
  if (matches.length === 0) {
    throw new UsageError(`No phone with published keys matches "${query}".`, { hint: known ? `Phones: ${known}` : "Open Relo on the phone, then run relo keys status" });
  }
  if (matches.length > 1) {
    throw new UsageError(`"${query}" matches ${matches.length} phones.`, { hint: `Use the id: ${matches.map((device) => `${device.deviceId} (${phoneLabel(device)})`).join(", ")}` });
  }
  return matches[0];
}

/** "5 min ago", "3 days ago": for the table and the approve prompt. */
function ago(iso, now) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return undefined;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const PLAIN = { auto: "trusted", verified: "trusted, verified", approved: "trusted, approved here", pending: "waiting for approval",
  changed: "security code changed, not encrypted for", new: "not trusted yet", linked: "linked browser", "not linked": "browser, not linked" };

function describeDevice(store, apiUrl, device, phones) {
  const pinned = store.trusted[trustKey(apiUrl, device.deviceId)];
  let prekeyOk = false;
  try {
    prekeyOk = Boolean(device.prekey && verifyPrekey({
      identityPublicKey: fromB64u(device.identityKey.publicKey, { length: 65 }),
      prekey: { ...device.prekey, deviceId: device.deviceId },
    }));
  } catch {
    prekeyOk = false;
  }
  const browser = device.kind === "browser";
  const model = browser ? undefined : isSimulator(device) ? "Simulator" : modelName(device.model);
  return Object.fromEntries(Object.entries({
    deviceId: device.deviceId,
    ...(browser ? { kind: "browser" } : {}),
    name: device.name,
    ...(model ? { model } : {}),
    ...(!browser && isSimulator(device) ? { simulator: true } : {}),
    ...(browser ? {} : { handle: phoneHandle(device, phones) }),
    keyId: device.identityKey.keyId,
    // A browser is never verified here: it reads only while a trusted phone's link signature holds.
    trust: browser ? (pinned ? "linked" : "not linked") : trustState(store, apiUrl, device),
    prekey: !device.prekey ? "missing" : !prekeyOk ? "invalid" : device.prekey.stale ? "stale" : "fresh",
    ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
    ...(pinned?.notice ? { notice: pinned.notice } : {}),
  }).filter(([, value]) => value !== undefined));
}

/** The human table for `relo keys status` at a terminal (--json, or piped output, gets the JSON line). */
function statusTable({ identity, strict, required, devices, notes }, now) {
  const rows = devices.map((device) => [
    device.name ?? device.deviceId,
    device.kind === "browser" ? "Browser" : device.model ?? "",
    `${PLAIN[device.trust] ?? device.trust}${device.prekey === "fresh" || device.kind === "browser" ? "" : device.prekey === "stale" ? " (key not renewed lately)" : ` (no usable key: open Relo on it)`}`,
    ago(device.lastSeenAt, now) ?? "",
  ]);
  const header = ["Name", "Model", "Status", "Last seen"];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  const line = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  const lines = [
    `This computer: key ${identity.keyId}${strict ? " · strict mode on" : ""}${required ? " · encryption required" : ""}`,
    "",
    ...(rows.length ? [line(header), ...rows.map(line)] : ["No phone has published keys yet: open Relo on the iPhone."]),
  ];
  if (notes.length) lines.push("", ...notes.map((note) => `• ${note}`));
  return lines.join("\n");
}

/** `relo keys`: this computer's encryption identity and the phones it seals for (trusted automatically). */
export async function runKeysCommand(command) {
  const { options, group, action, rest, dependencies, client, config } = command;
  if (group !== "keys") return undefined;
  assertAllowedOptions(options, action === "approve" ? ["yes"] : []);
  const apiUrl = config.apiUrl;

  if (action === "status") {
    assertNoExtra(rest, 0, USAGE);
    const { store, devices } = await ensureTrust({ client, config, dependencies, details: true });
    // An older server has no policy route; status still reports the keys.
    let policy = null;
    try {
      policy = await client.endToEndPolicy();
    } catch {}
    const now = dependencies.now?.() ?? Date.now();
    const phones = listedPhones(store, apiUrl, devices);
    const data = {
      identity: { keyId: store.identity.keyId, createdAt: store.identity.createdAt },
      required: policy?.required === true,
      strict: store.strict === true,
      devices: devices.filter((device) => device?.identityKey).map((device) => describeDevice(store, apiUrl,
        { ...device, name: device.name ?? store.trusted[trustKey(apiUrl, device.deviceId)]?.name }, phones)),
    };
    const notes = trustNotices(store, apiUrl, now, devices);
    return { ...result("keys.status", data, { notes }), text: statusTable({ ...data, identity: data.identity, notes }, now) };
  }

  if (action === "approve") {
    // A person accepts a phone that waits for approval (or whose changed key strict mode holds) here,
    // instead of on a trusted iPhone. The phone becomes "approved": trusted like "verified" for sealing.
    assertNoExtra(rest, 1, USAGE);
    const { store, devices } = await ensureTrust({ client, config, dependencies, details: true });
    const phones = listedPhones(store, apiUrl, devices);
    const device = findPhone(rest[0], phones);
    const label = phoneLabel(device);
    const state = trustState(store, apiUrl, device);
    if (["auto", "verified", "approved"].includes(state)) {
      return result("keys.approve", { deviceId: device.deviceId, name: device.name, trust: state, approved: false },
        { message: `${label} is already trusted.` });
    }
    const number = safetyNumber(fromB64u(store.identity.publicKey, { length: 65 }), fromB64u(device.identityKey.publicKey, { length: 65 }));
    const yes = options.yes === true;
    if (!yes && (!dependencies.stdinIsTTY || !dependencies.confirm)) {
      throw needsPerson("approve", `Only the owner approves a phone: ask them to run relo keys approve ${phoneHandle(device, phones)} in their terminal`);
    }
    if (!yes) {
      const now = dependencies.now?.() ?? Date.now();
      const model = isSimulator(device) ? "Simulator (not a real iPhone)" : modelName(device.model);
      const when = (iso) => (iso ? `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC (${ago(iso, now)})` : undefined);
      const lines = [
        state === "changed" ? `${label} has a new security code (it was reinstalled or reset).` : `${label} is waiting for approval.`,
        "",
        `  Name:        ${device.name ?? device.deviceId}`,
        ...(model ? [`  Model:       ${model}`] : []),
        ...(device.registeredAt ? [`  Signed in:   ${when(device.registeredAt)}`] : []),
        ...(device.lastSeenAt ? [`  Last seen:   ${when(device.lastSeenAt)}`] : []),
        `  Key id:      ${device.identityKey.keyId}   (shown under it in Relo → Settings → Security on ${trustedPhonesLabel(store, apiUrl)})`,
        `  Code starts: ${number.split(" ")[0]}   (${PHONE_SCREEN.replace("the iPhone", "that phone")})`,
        `  Id:          ${device.deviceId}`,
        "",
        "Approve only a phone you signed in yourself. Once approved, this computer encrypts everything for it too.",
      ];
      dependencies.stderr?.(lines.join("\n"));
      if (!(await dependencies.confirm(`Approve ${label}? [y/N] `))) {
        return result("keys.approve", { deviceId: device.deviceId, name: device.name, trust: state, approved: false }, { message: "Not approved." });
      }
    }
    const pinned = store.trusted[trustKey(apiUrl, device.deviceId)];
    store.trusted[trustKey(apiUrl, device.deviceId)] = {
      deviceId: device.deviceId, name: device.name ?? pinned?.name, ...(device.model ? { model: device.model } : {}),
      ...(device.isSimulator === true ? { isSimulator: true } : {}),
      keyId: device.identityKey.keyId, publicKey: device.identityKey.publicKey,
      level: "approved", trustedAt: new Date(dependencies.now()).toISOString(),
    };
    // Approving a phone here also commits this computer: the next phone waits for approval too.
    store.committed = { ...(store.committed ?? {}), [apiUrl]: true };
    await saveKeyStore(storePath(dependencies), store);
    return result("keys.approve", { deviceId: device.deviceId, name: device.name, trust: "approved", approved: true },
      { message: `${label} approved: this computer now encrypts for it.` });
  }

  if (action === "remove") {
    // Signing a phone out is the owner's, in the Dashboard: no CLI credential can revoke a phone
    // (DELETE /api/devices/:id is the phone's own sign-out), so this says exactly where to do it.
    assertNoExtra(rest, 1, USAGE);
    const { store, devices } = await ensureTrust({ client, config, dependencies, details: true });
    const phones = listedPhones(store, apiUrl, devices);
    const device = findPhone(rest[0], phones);
    const label = phoneLabel(device);
    return result("keys.remove", { deviceId: device.deviceId, name: device.name, removed: false, where: DASHBOARD_REMOVE },
      { message: `A computer cannot sign a phone out. Remove ${label} in the Relo ${DASHBOARD_REMOVE} (or Decline it in Relo → Settings → Security on ${trustedPhonesLabel(store, apiUrl)}).` });
  }

  if (action === "verify") {
    // Optional: comparing safety numbers upgrades an automatically trusted phone to "verified".
    assertNoExtra(rest, 1, USAGE);
    const { store, devices } = await ensureTrust({ client, config, dependencies });
    if (devices.some((entry) => entry?.deviceId === rest[0] && entry.kind === "browser")) {
      throw new UsageError("A browser is linked from Relo on the iPhone (Settings → Security → Link a browser), not verified here.");
    }
    const device = findPhone(rest[0], listedPhones(store, apiUrl, devices));
    const deviceId = device.deviceId;
    const number = safetyNumber(fromB64u(store.identity.publicKey, { length: 65 }), fromB64u(device.identityKey.publicKey, { length: 65 }));
    const state = trustState(store, apiUrl, device);
    if (state === "verified") return result("keys.verify", { deviceId, trust: "verified", safetyNumber: number });
    if (!dependencies.stdinIsTTY || !dependencies.confirm) throw needsPerson("verify");
    dependencies.stderr?.(`Security code for ${device.name} (${deviceId}):\n\n  ${number.replace(/((?:\d{5} ){5}\d{5}) /, "$1\n  ")}\n`);
    const same = await dependencies.confirm(`Does ${PHONE_SCREEN} show exactly this number? [y/N] `);
    if (!same) return result("keys.verify", { deviceId, trust: state, safetyNumber: number }, { message: "Not marked verified." });
    store.trusted[trustKey(apiUrl, deviceId)] = {
      deviceId, name: device.name, ...(device.model ? { model: device.model } : {}),
      keyId: device.identityKey.keyId, publicKey: device.identityKey.publicKey,
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
    // A person who forgets the last trusted phone starts over: the next phone is trusted on first use
    // again. Without a person at the terminal the computer stays committed (review H2).
    if (dependencies.stdinIsTTY && trustedPhones(store, apiUrl).length === 0 && store.committed) delete store.committed[apiUrl];
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
