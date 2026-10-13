import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { answerSigningInput, b64u, generateKeyPair, keyId, prekeySigningInput, questionAnswerSigningInput, signBytes } from "../src/e2ee.mjs";
import { loadKeyStore, trustKey } from "../src/keystore.mjs";
import { sealNoticeRequest } from "../src/seal-notice.mjs";
import { ensureTrust } from "../src/trust.mjs";

// A phone added after the first is approved with one tap on a trusted phone, never by comparing keys.
const apiUrl = "https://relo.example";
const interactionId = "int_00000000-0000-4000-8000-000000000042";
const start = Date.parse("2026-10-13T18:00:00.000Z");

function phone(deviceId, name) {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  const createdAt = new Date(start).toISOString();
  return { identity, deviceId, name,
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: false,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } };
}
const owner = phone("dev_00000000-0000-4000-8000-00000000000a", "iPhone");
const ipad = phone("dev_00000000-0000-4000-8000-0000000000bb", "iPad");

/** The trusted (or any) phone's answer to the approval question, signed as the iPhone app does. */
function answer(signer, { state = "approved", question, at }) {
  const respondedAt = new Date(at).toISOString();
  const fields = { interactionId, notificationId: "ntf_1", deviceId: signer.deviceId, value: "approve", respondedAt };
  return { interaction: { id: interactionId, eventId: "ntf_1", state, respondingDevice: { id: signer.deviceId },
    response: state === "approved" ? { e2eeKeyId: signer.identityKey.keyId, e2eeSignedAt: respondedAt,
      e2eeSignature: b64u(signBytes(signer.identity.privateKey, answerSigningInput(fields))), e2eeQuestion: question,
      e2eeQuestionSignature: b64u(signBytes(signer.identity.privateKey, questionAnswerSigningInput({ ...fields, question }))) } : {} } };
}

function harness() {
  const folder = mkdtempSync(join(tmpdir(), "relo-approval-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_SEALED_CARD_DIR: join(folder, "state", "cards") };
  let now = start;
  const asked = [];
  let reply = null;
  const server = {
    publishClientKey: async () => ({}),
    listDeviceKeys: async () => ({ devices: [owner, ipad] }),
    createInteraction: async (body, key) => { asked.push({ body, key }); return { interaction: { id: interactionId } }; },
    getInteraction: async () => reply ?? { interaction: { id: interactionId, state: "pending" } },
  };
  const dependencies = { configPath: () => join(folder, "config.json"), env, now: () => now };
  const notice = { title: "SECRET", body: "SECRET BODY", sourceName: "Codex" };
  return {
    asked, server, env, dependencies,
    setReply: (value) => { reply = value; },
    advance: (ms) => { now += ms; },
    now: () => now,
    send: async (key = "n") => {
      const notes = [];
      const request = await sealNoticeRequest({ body: notice, key, client: server, config: { apiUrl }, dependencies, notes });
      return { notes, recipients: request.sealed.alerts.map((alert) => alert.recipients[0].device) };
    },
    level: async (device) => (await loadKeyStore(env.RELO_KEY_STORE_PATH)).trusted[trustKey(apiUrl, device.deviceId)]?.level,
    cleanup: () => rmSync(folder, { recursive: true, force: true }),
  };
}

async function firstPhoneOnly(h) {
  await ensureTrust({ client: { ...h.server, listDeviceKeys: async () => ({ devices: [owner] }) }, config: { apiUrl }, dependencies: h.dependencies });
}

test("a new phone is approved by one tap on the trusted phone, then receives sealed messages", async () => {
  const h = harness();
  try {
    await firstPhoneOnly(h);
    const first = await h.send("n1");
    assert.equal(await h.level(ipad), "pending");
    assert.deepEqual(first.recipients, [owner.deviceId], "nothing is sealed to the new phone yet");
    assert.equal(h.asked.length, 1, "the trusted phone is asked once");
    const { body } = h.asked[0];
    assert.equal(body.type, "approval");
    assert.deepEqual(body.sealed.alerts.map((alert) => alert.recipients[0].device), [owner.deviceId], "only trusted phones see the question");
    assert.ok(!JSON.stringify(body).includes("iPad"), "the question is end-to-end encrypted");
    await h.send("n2");
    assert.equal(h.asked.length, 1, "an open question is not asked again");

    h.advance(60_000);
    h.setReply(answer(owner, { question: body.sealed.content.context, at: h.now() }));
    const approved = await h.send("n3");
    assert.equal(await h.level(ipad), "auto");
    assert.deepEqual(approved.recipients.sort(), [owner.deviceId, ipad.deviceId].sort());
    assert.ok(approved.notes.some((note) => note.includes("approved on your trusted phone")));
  } finally { h.cleanup(); }
});

test("the new phone (or the server) cannot approve itself, and a decline sticks", async () => {
  const h = harness();
  try {
    await firstPhoneOnly(h);
    await h.send("n1");
    const question = h.asked[0].body.sealed.content.context;
    h.advance(60_000);
    h.setReply(answer(ipad, { question, at: h.now() }));
    await h.send("n2");
    assert.equal(await h.level(ipad), "pending", "an approval signed by the new phone itself is refused");
    h.setReply(answer(owner, { question: "ntf:another-question", at: h.now() }));
    await h.send("n3");
    assert.equal(await h.level(ipad), "pending", "an approval of another question is refused");

    // A refused answer is asked again after a day; a decline is final for this key.
    h.advance(25 * 3_600_000);
    h.setReply(null);
    await h.send("n4");
    assert.equal(h.asked.length, 2);
    h.setReply({ interaction: { id: interactionId, state: "denied" } });
    const declined = await h.send("n5");
    assert.equal(await h.level(ipad), "pending");
    assert.ok(declined.notes.some((note) => note.includes("declined")));
    h.advance(48 * 3_600_000);
    await h.send("n6");
    assert.equal(h.asked.length, 2, "never asked again after a decline");
  } finally { h.cleanup(); }
});
