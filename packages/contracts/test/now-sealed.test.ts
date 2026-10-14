import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { agentSessionSummarySchema,base64UrlByteLength,nowItemSchema,ownerStateInputSchema,sealedEnvelopeSchema } from "../src/index.js";

const b64 = (bytes: number,fill = 7) => Buffer.alloc(bytes,fill).toString("base64url");
const DEVICE = "dev_00000000-0000-4000-8000-000000000001";
function envelope(kind: "card" | "question") {
  return { v: "relo.e2e.v1",kind,context: "ntf:0123456789abcdef0123456789abcdef",sender: `k_${"A".repeat(22)}`,
    recipients: [{ device: DEVICE,prekey: "pk_1",enc: b64(65),key: b64(48) }],
    nonce: b64(12),ct: b64(256 + 16),sig: b64(64) };
}

const fixture = JSON.parse(readFileSync(new URL("../fixtures/owner-state-v1.json",import.meta.url),"utf8"));
const item = nowItemSchema.parse([...fixture.nowSummary.needsYou,...fixture.nowSummary.running,...fixture.nowSummary.recent][0]);

test("base64UrlByteLength matches Node's canonical base64url round trip",() => {
  for (let length = 0; length < 70; length++) {
    const text = b64(length,0xa5);
    assert.equal(base64UrlByteLength(text || "A"),text ? length : null);
  }
  assert.equal(base64UrlByteLength("AB"),null); // non-zero unused bits: not canonical
  assert.equal(base64UrlByteLength("A"),null);
  assert.equal(base64UrlByteLength("AA=="),null);
});

test("the sealed envelope schema accepts a well-formed envelope and refuses bad sizes and extra fields",() => {
  assert.ok(sealedEnvelopeSchema.safeParse(envelope("card")).success);
  assert.ok(!sealedEnvelopeSchema.safeParse({ ...envelope("card"),ct: b64(100) }).success);
  assert.ok(!sealedEnvelopeSchema.safeParse({ ...envelope("card"),nonce: b64(11) }).success);
  assert.ok(!sealedEnvelopeSchema.safeParse({ ...envelope("card"),title: "plain" }).success);
  assert.ok(!sealedEnvelopeSchema.safeParse({ ...envelope("card"),kind: "secret" }).success);
});

test("a Now item carries optional sealed {card,question}, each an envelope or null",() => {
  assert.equal(item.sealed,undefined);
  assert.ok(nowItemSchema.safeParse({ ...item,sealed: { card: envelope("card"),question: null } }).success);
  assert.ok(nowItemSchema.safeParse({ ...item,sealed: { card: null,question: envelope("question") } }).success);
  assert.ok(!nowItemSchema.safeParse({ ...item,sealed: { card: envelope("card") } }).success);
  assert.ok(!nowItemSchema.safeParse({ ...item,sealed: { card: { opaque: true },question: null } }).success);
  assert.ok(!nowItemSchema.safeParse({ ...item,sealed: { card: null,question: null,alert: null } }).success);
});

test("derive input: a question may carry the owner's dismissal",() => {
  const input = fixture.derive[0].input;
  const question = { standing: "missed",askedAt: input.work.startedAt,openedAt: null };
  assert.ok(ownerStateInputSchema.safeParse({ ...input,question }).success);
  assert.ok(ownerStateInputSchema.safeParse({ ...input,question: { ...question,dismissedAt: input.work.startedAt } }).success);
  assert.ok(ownerStateInputSchema.safeParse({ ...input,question: { ...question,dismissedAt: null } }).success);
});

test("session rows no longer carry the fields for iPhone builds before 0.10.2",() => {
  const keys = Object.keys(agentSessionSummarySchema.shape);
  for (const gone of ["state","lastEvent","lastEventAt"]) assert.ok(!keys.includes(gone),gone);
});
