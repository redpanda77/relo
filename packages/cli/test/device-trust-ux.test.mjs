import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runKeysCommand } from "../src/commands/keys.mjs";
import { isSimulator, matchPhones, modelName, phoneHandle, phoneLabel } from "../src/device-names.mjs";
import { approveDeviceSigningInput, b64u, generateKeyPair, keyId, linkSigningInput, prekeySigningInput, signBytes } from "../src/e2ee.mjs";
import { loadKeyStore, saveKeyStore, trustKey } from "../src/keystore.mjs";
import { sealCardRequest } from "../src/seal-card.mjs";
import { sealNoticeRequest } from "../src/seal-notice.mjs";
import { ensureTrust, trustNotices } from "../src/trust.mjs";

// The device-trust flows a person meets: friendly names, notes that say what to do, `relo keys
// approve` / `remove`, skipped phones named on cards, approvals from a linked browser, and simulators.
const apiUrl = "https://relo.example";

function endpoint(deviceId, { kind = "phone", name = "iPhone", model, createdAt = new Date().toISOString() } = {}) {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  return { identity, device: { deviceId, kind, name, ...(model ? { model } : {}),
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: false,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } } };
}

const owner = endpoint("dev_00000000-0000-4000-8000-00000000000a", { name: "iPhone", model: "iPhone18,1" });
const second = endpoint("dev_00000000-0000-4000-8000-00000000000b", { name: "Work phone", model: "iPhone17,3" });
const simulator = endpoint("dev_00000000-0000-4000-8000-0000000000c1", { name: "iPhone Air", model: "arm64" });
const browser = endpoint("brw_00000000-0000-4000-8000-0000000000d1", { kind: "browser", name: "Chrome on macOS" });

function link(signer = owner, signedAt = new Date().toISOString()) {
  return { deviceId: signer.device.deviceId, signedAt, signature: b64u(signBytes(signer.identity.privateKey,
    linkSigningInput({ browserId: browser.device.deviceId, identityKey: browser.device.identityKey.publicKey, phoneDeviceId: signer.device.deviceId, signedAt }))) };
}

function approval(signer, target) {
  const signedAt = new Date().toISOString();
  return { deviceId: signer.device.deviceId, signedAt, signature: b64u(signBytes(signer.identity.privateKey,
    approveDeviceSigningInput({ deviceId: target.device.deviceId, identityKey: target.device.identityKey.publicKey,
      approverDeviceId: signer.device.deviceId, signedAt }))) };
}

function harness({ inventory = [] } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "relo-trust-ux-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_SEALED_CARD_DIR: join(folder, "cards") };
  const printed = [];
  const state = { devices: [], inventory };
  const dependencies = { configPath: () => join(folder, "config.json"), env, now: () => Date.now(), stdinIsTTY: false,
    confirm: async () => true, stderr: (line) => printed.push(line) };
  const client = (devices) => ({ publishClientKey: async () => ({}), listDeviceKeys: async () => ({ devices: devices ?? state.devices }),
    listDevices: async () => ({ devices: state.inventory }), endToEndPolicy: async () => ({ required: false }) });
  const trust = (devices) => ensureTrust({ client: client(devices), config: { apiUrl }, dependencies });
  const keys = (action, rest = [], { options = {}, ...overrides } = {}) => runKeysCommand({ group: "keys", action, rest, options,
    dependencies: { ...dependencies, ...overrides }, client: client(), config: { apiUrl } });
  const store = () => loadKeyStore(env.RELO_KEY_STORE_PATH);
  const level = async (endpointValue) => (await store()).trusted[trustKey(apiUrl, endpointValue.device.deviceId)]?.level;
  return { folder, env, printed, state, dependencies, client, trust, keys, store, level,
    cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

test("model identifiers become names a person knows; a simulator says so", () => {
  assert.equal(modelName("iPhone18,1"), "iPhone 17 Pro");
  assert.equal(modelName("iPhone18,4"), "iPhone Air");
  assert.equal(modelName("arm64"), "Simulator");
  assert.equal(modelName("x86_64"), "Simulator");
  assert.equal(modelName("iPhone99,1"), "iPhone");
  assert.equal(isSimulator({ model: "arm64" }), true);
  assert.equal(isSimulator({ model: "iPhone18,4", isSimulator: true }), true);
  assert.equal(isSimulator({ model: "iPhone18,4" }), false);
  assert.equal(phoneLabel(simulator.device), "iPhone Air (Simulator)");
  assert.equal(phoneLabel(owner.device), "iPhone 17 Pro", "a phone named just iPhone is called by its model");
  assert.equal(phoneLabel(second.device), "Work phone (iPhone 16)");
  const phones = [owner.device, second.device, simulator.device];
  assert.equal(phoneHandle(simulator.device, phones), "iphone-air");
  assert.equal(phoneHandle(second.device, phones), "work-phone");
  assert.equal(phoneHandle(owner.device, phones), "iphone-17-pro");
  assert.deepEqual(matchPhones("iPhone Air", phones).map((device) => device.deviceId), [simulator.device.deviceId]);
  assert.deepEqual(matchPhones(owner.device.deviceId, phones).map((device) => device.deviceId), [owner.device.deviceId]);
  // Two phones both named "iPhone" without a model: the handle falls back to the id.
  const twins = [{ deviceId: "dev_1", name: "iPhone" }, { deviceId: "dev_2", name: "iPhone" }];
  assert.equal(phoneHandle(twins[0], twins), "dev_1");
});

test("a waiting phone's note names it, the phone that can approve it, and the exact command", async () => {
  const h = harness();
  try {
    await h.trust([owner.device]);
    await h.trust([owner.device, second.device]);
    const notes = trustNotices(await h.store(), apiUrl);
    assert.deepEqual(notes, ["Work phone (iPhone 16) is waiting for approval: run `relo keys approve work-phone`, approve it on"
      + " your iPhone 17 Pro in Relo → Settings → Devices, or remove it (Dashboard → Account → Security → Devices → Remove)"]);
  } finally { h.cleanup(); }
});

test("relo keys approve: refuses without a person unless --yes, shows what to compare, and makes the phone a recipient", async () => {
  const h = harness();
  try {
    await h.trust([owner.device]);
    h.state.devices = [owner.device, second.device];
    await assert.rejects(h.keys("approve", ["work-phone"]), (error) => error.code === "PERSON_REQUIRED" && /ask them to run relo keys approve work-phone/.test(error.details.hint));
    assert.equal(await h.level(second), "pending");
    // A person who says no leaves it pending.
    const declined = await h.keys("approve", ["work-phone"], { stdinIsTTY: true, confirm: async () => false });
    assert.equal(declined.data.approved, false);
    assert.equal(await h.level(second), "pending");
    const shown = h.printed.join("\n");
    assert.match(shown, /Work phone \(iPhone 16\) is waiting for approval/);
    assert.match(shown, /Model: +iPhone 16/);
    assert.match(shown, new RegExp(`Key id: +${second.device.identityKey.keyId}`));
    assert.match(shown, /Code starts: +\d{5} /);
    assert.match(shown, /your iPhone 17 Pro/);
    const approved = await h.keys("approve", ["work-phone"], { stdinIsTTY: true });
    assert.deepEqual(approved.data, { deviceId: second.device.deviceId, name: "Work phone", trust: "approved", approved: true });
    assert.equal(await h.level(second), "approved");
    assert.equal((await h.keys("status")).data.devices.find((device) => device.deviceId === second.device.deviceId).trust, "approved");
    const sealed = (await sealNoticeRequest({ body: { title: "T", body: "B", sourceName: "Codex" }, key: "k1", client: h.client(),
      config: { apiUrl }, dependencies: h.dependencies, notes: [] })).sealed;
    assert.ok(sealed.alerts.some((alert) => alert.recipients[0].device === second.device.deviceId));
    assert.equal((await h.keys("approve", [second.device.deviceId])).data.approved, false, "already trusted: nothing to do");
  } finally { h.cleanup(); }
});

test("relo keys approve --yes works without a terminal; an unknown or ambiguous name says which phones exist", async () => {
  const h = harness();
  try {
    await h.trust([owner.device]);
    h.state.devices = [owner.device, simulator.device];
    await assert.rejects(h.keys("approve", ["pixel"]), (error) => error.code === "USAGE_ERROR" || /No phone/.test(error.message));
    assert.equal((await h.keys("approve", ["iphone-air"], { options: { yes: true } })).data.trust, "approved");
    assert.equal(await h.level(simulator), "approved", "a simulator can be approved explicitly");
  } finally { h.cleanup(); }
});

test("relo keys remove points at the Dashboard: no CLI credential can sign a phone out", async () => {
  const h = harness();
  try {
    await h.trust([owner.device]);
    h.state.devices = [owner.device, second.device];
    const output = await h.keys("remove", ["work-phone"]);
    assert.equal(output.data.removed, false);
    assert.equal(output.data.where, "Dashboard → Account → Security → Devices → Remove");
    assert.match(output.message, /Remove Work phone \(iPhone 16\) in the Relo Dashboard → Account → Security → Devices → Remove/);
  } finally { h.cleanup(); }
});

test("relo keys status: a table for a person (name, model, plain status, last seen), JSON fields for agents", async () => {
  const h = harness({ inventory: [{ deviceId: simulator.device.deviceId, lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString() }] });
  try {
    await h.trust([owner.device]);
    h.state.devices = [owner.device, simulator.device];
    const output = await h.keys("status");
    const sim = output.data.devices.find((device) => device.deviceId === simulator.device.deviceId);
    assert.equal(sim.model, "Simulator");
    assert.equal(sim.simulator, true);
    assert.equal(sim.handle, "iphone-air");
    assert.equal(sim.trust, "pending");
    assert.ok(sim.lastSeenAt);
    assert.match(output.text, /^Name +Model +Status +Last seen$/mu);
    assert.match(output.text, /^iPhone Air +Simulator +waiting for approval +5 min ago$/mu);
    assert.match(output.text, /^iPhone +iPhone 17 Pro +trusted/mu);
    assert.match(output.text, /relo keys approve iphone-air/);
    assert.ok(output.notes.some((note) => note.startsWith("iPhone Air (Simulator) is waiting for approval")));
  } finally { h.cleanup(); }
});

test("cards name every phone they skip and why, like notify and ask", async () => {
  const h = harness();
  try {
    await h.trust([owner.device]);
    const notes = [];
    await sealCardRequest({ body: { title: "Deploy", status: "Building" }, cardId: null, key: "c1", client: h.client([owner.device, simulator.device]),
      config: { apiUrl }, dependencies: h.dependencies, notes });
    assert.ok(notes.includes("card end-to-end encrypted for 1 phone; not readable on iPhone Air (Simulator)"
      + " (waiting for approval: relo keys approve iphone-air)"), notes.join("\n"));
    await h.trust([owner.device, second.device]);
    const more = [];
    await sealCardRequest({ body: { title: "Deploy", status: "Building" }, cardId: null, key: "c2", client: h.client([owner.device, { ...second.device, prekey: null }]),
      config: { apiUrl }, dependencies: h.dependencies, notes: more });
    assert.ok(more.some((note) => note.includes("Work phone (iPhone 16) (waiting for approval")), more.join("\n"));
  } finally { h.cleanup(); }
});

test("an approval signed by a linked browser counts only outside strict mode, for a current link, with a valid signature", async () => {
  const signedBy = (target) => approval(browser, target);
  const listed = (target, { browserLink = link(), approvalValue = signedBy(target) } = {}) =>
    [owner.device, { ...browser.device, link: browserLink }, { ...target.device, approval: approvalValue }];
  // Strict mode refuses it.
  let h = harness();
  try {
    await h.trust([owner.device]);
    await saveKeyStore(h.env.RELO_KEY_STORE_PATH, { ...(await h.store()), strict: true });
    await h.trust(listed(second));
    assert.equal(await h.level(second), "pending");
  } finally { h.cleanup(); }
  // An expired link, no link, a link by an untrusted phone, a forged signature: refused.
  h = harness();
  try {
    await h.trust([owner.device]);
    const expired = link(owner, new Date(Date.now() - 15 * 86_400_000).toISOString());
    for (const variant of [{ browserLink: expired }, { browserLink: null }, { browserLink: link(second) },
      { approvalValue: { ...signedBy(second), signature: b64u(Buffer.alloc(64, 5)) } },
      { approvalValue: approval(browser, simulator) }]) {
      await h.trust(listed(second, variant));
      assert.equal(await h.level(second), "pending", JSON.stringify(Object.keys(variant)));
    }
    // An unlisted browser cannot approve either.
    await h.trust([owner.device, { ...second.device, approval: signedBy(second) }]);
    assert.equal(await h.level(second), "pending");
    // The real thing: accepted, with its own notice naming the browser.
    await h.trust(listed(second));
    assert.equal(await h.level(second), "auto");
    const store = await h.store();
    assert.equal(store.trusted[trustKey(apiUrl, second.device.deviceId)].notice.kind, "approved_from_browser");
    assert.ok(trustNotices(store, apiUrl).some((note) => note.startsWith("Work phone (iPhone 16) was approved from Chrome on macOS")));
  } finally { h.cleanup(); }
});

test("a phone approval names the phone that approved it", async () => {
  const h = harness();
  try {
    await h.trust([owner.device]);
    await h.trust([owner.device, { ...second.device, approval: approval(owner, second) }]);
    assert.ok(trustNotices(await h.store(), apiUrl).includes("Work phone (iPhone 16) was approved on iPhone 17 Pro: messages are now encrypted for it too"));
  } finally { h.cleanup(); }
});

test("simulators: never trusted on first contact or on re-trust, never block a real phone's re-trust, held on a key change", async () => {
  let h = harness();
  try {
    // First contact with a simulator and a real phone: only the real phone is trusted.
    await h.trust([simulator.device, owner.device]);
    assert.equal(await h.level(owner), "auto");
    assert.equal(await h.level(simulator), "pending");
  } finally { h.cleanup(); }
  h = harness();
  try {
    // A simulator alone on first contact is not trusted, and the first real phone still is.
    await h.trust([simulator.device]);
    assert.equal(await h.level(simulator), "pending");
    await h.trust([simulator.device, owner.device]);
    assert.equal(await h.level(owner), "auto");
  } finally { h.cleanup(); }
  h = harness();
  try {
    // The trusted phone was set up again while an approved simulator stays listed: the new real
    // phone is re-trusted automatically; a newly listed simulator is not.
    await h.trust([owner.device]);
    h.state.devices = [owner.device, simulator.device];
    await h.keys("approve", ["iphone-air"], { options: { yes: true } });
    const fresh = endpoint("dev_00000000-0000-4000-8000-0000000000f1", { name: "iPhone", model: "iPhone18,2" });
    const otherSim = endpoint("dev_00000000-0000-4000-8000-0000000000c2", { name: "iPhone 17", model: "x86_64" });
    await h.trust([simulator.device, otherSim.device, fresh.device]);
    assert.equal(await h.level(fresh), "auto");
    assert.equal((await h.store()).trusted[trustKey(apiUrl, fresh.device.deviceId)].notice.kind, "phone_replaced");
    assert.equal(await h.level(otherSim), "pending");
    // The approved simulator's key changes (erased): held until approved again, with a note saying so.
    const erased = { ...endpoint(simulator.device.deviceId, { name: "iPhone Air", model: "arm64" }).device };
    await h.trust([erased, fresh.device]);
    const store = await h.store();
    assert.equal(store.trusted[trustKey(apiUrl, simulator.device.deviceId)].publicKey, simulator.device.identityKey.publicKey);
    assert.ok(trustNotices(store, apiUrl, Date.now(), [erased, fresh.device]).some((note) =>
      note.startsWith("security code changed for iPhone Air (Simulator): nothing is encrypted for it until you run `relo keys approve iphone-air`")));
  } finally { h.cleanup(); }
});

test("the model comes from the device inventory when the key listing lacks it", async () => {
  const bare = { ...simulator.device };
  delete bare.model;
  const h = harness({ inventory: [{ deviceId: bare.deviceId, model: "arm64", lastSeenAt: new Date().toISOString() }] });
  try {
    await h.trust([owner.device]);
    await h.trust([owner.device, bare]);
    const entry = (await h.store()).trusted[trustKey(apiUrl, bare.deviceId)];
    assert.equal(entry.model, "arm64");
    assert.equal(entry.level, "pending");
  } finally { h.cleanup(); }
});

test("at a terminal relo keys status prints the table; --json and piped output keep one JSON line", async () => {
  const { run } = await import("../src/cli.mjs");
  const h = harness();
  try {
    await h.trust([owner.device]);
    h.state.devices = [owner.device, second.device];
    const overrides = { env: h.env, configPath: () => join(h.folder, "config.json"),
      loadConfig: async () => ({ apiUrl, token: `klb_${"x".repeat(44)}`, path: join(h.folder, "config.json"), principal: { id: "prn_test", scopes: [] } }),
      clientFactory: () => h.client() };
    const capture = async (argv, stdoutIsTTY) => {
      const out = [];
      const err = [];
      assert.equal(await run(argv, { stdout: (line) => out.push(line), stderr: (line) => err.push(line), stdoutIsTTY }, overrides), 0);
      return { out, err };
    };
    const tty = await capture(["keys", "status"], true);
    assert.match(tty.out.join("\n"), /^Name +Model +Status +Last seen$/mu);
    assert.match(tty.out.join("\n"), /Work phone +iPhone 16 +waiting for approval/);
    for (const [argv, isTTY] of [[["keys", "status", "--json"], true], [["keys", "status"], false]]) {
      const { out } = await capture(argv, isTTY);
      assert.equal(out.length, 1);
      const line = JSON.parse(out[0]);
      assert.equal(line.devices.find((device) => device.id === second.device.deviceId).handle, "work-phone");
      assert.match(line.note, /relo keys approve work-phone/);
    }
  } finally { h.cleanup(); }
});

test("the key listing's simulator flag alone keeps a simulator out of first contact", async () => {
  const flagged = { ...simulator.device, simulator: true };
  delete flagged.model;
  const h = harness();
  try {
    await h.trust([flagged, owner.device]);
    assert.equal(await h.level(simulator), "pending");
    assert.equal(await h.level(owner), "auto");
    assert.equal(phoneLabel((await h.store()).trusted[trustKey(apiUrl, simulator.device.deviceId)]), "iPhone Air (Simulator)");
  } finally { h.cleanup(); }
});
