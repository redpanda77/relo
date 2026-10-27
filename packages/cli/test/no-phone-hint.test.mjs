import "./hermetic-env.mjs";
import { LOCAL_RELINK } from "../src/shared/errors.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { printFailure, outputMode } from "../src/shared/output.mjs";
import { ApiError, NO_PHONE_ENCRYPTION_HINT } from "../src/shared/errors.mjs";
import { worksClient } from "../src/work/works-client.mjs";

// A remote server that requires encryption, on an account with no iPhone: say what to do, never "open Relo on the iPhone".
const HINT = "This server requires encryption and has no iPhone to encrypt for: add your iPhone, or set encryption to Automatic in the Dashboard.";

test("the no-iPhone refusal says one thing everywhere", async () => {
  assert.equal(NO_PHONE_ENCRYPTION_HINT, HINT);
  const stdout = [];
  printFailure(new ApiError("refused", { status: 409, code: "END_TO_END_REQUIRED" }), outputMode(["--json"], false), { stdout: (line) => stdout.push(line), stderr: () => {} }, "notify");
  assert.match(stdout.join("\n"), /This server requires encryption and has no iPhone to encrypt for: add your iPhone, or set encryption to Automatic in the Dashboard\./u);
  assert.doesNotMatch(stdout.join("\n"), /open Relo on the iPhone/iu);

  const client = { apiUrl: "https://relo.example", token: "t", version: "1", request() {},
    fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: "end_to_end_required", message: "x" }) }) };
  await assert.rejects(worksClient(client, { sessionKey: "s", harness: "h" }).current(), (refusal) => {
    assert.equal(refusal.next, HINT);
    assert.doesNotMatch(`${refusal.what} ${refusal.next}`, /open Relo on the iPhone/iu);
    return true;
  });
  // A local account keeps its own wording.
  const local = { ...client, local: true };
  await assert.rejects(worksClient(local, { sessionKey: "s", harness: "h" }).current(), (refusal) => refusal.next === LOCAL_RELINK);
});
