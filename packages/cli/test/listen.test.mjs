import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { execute } from "../src/cli.mjs";
import { ApiError, AuthError, NetworkError } from "../src/errors.mjs";

function harness(pages) {
  const requests = [];
  const lines = [];
  const sleeps = [];
  let clock = 1_000_000;
  const client = {
    async listAnswers(query) {
      requests.push(query);
      clock += query.timeoutSeconds * 1_000;
      const next = pages.shift();
      if (next instanceof Error) throw next;
      return next ?? { answers: [], cursor: query.after ?? "cursor-unchanged-000" };
    },
  };
  const overrides = {
    loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44) }),
    clientFactory: () => client,
    identityDefaults: () => ({}),
    emit: (line) => lines.push(line),
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  };
  return { overrides, requests, lines, sleeps };
}

const answered = (id, extra = {}) => ({ id, eventId: `ntf_${id}`, type: "yes_no", state: "yes", action: "yes",
  respondedAt: "2026-10-13T12:00:00.000Z", cursor: `cursor-after-${id}-0000`, ...extra });

test("relo listen prints one line per answer and resumes from the last cursor", async () => {
  const { overrides, requests, lines } = harness([
    { answers: [answered("int_a", { correlationId: "deploy-1" }), answered("int_b", { type: "choice", state: "replied",
      action: "choose", response: { optionId: "roll-back", label: "Roll back" } })], cursor: "cursor-after-int_b-0000" },
    { answers: [], cursor: "cursor-after-int_b-0000" },
  ]);
  const out = await execute(["listen", "--timeout", "90s"], overrides);
  assert.deepEqual(lines, [
    { id: "int_a", eventId: "ntf_int_a", state: "yes", action: "yes", correlationId: "deploy-1",
      respondedAt: "2026-10-13T12:00:00.000Z", cursor: "cursor-after-int_a-0000" },
    { id: "int_b", eventId: "ntf_int_b", state: "chosen", action: "choose", option: "roll-back", label: "Roll back",
      respondedAt: "2026-10-13T12:00:00.000Z", cursor: "cursor-after-int_b-0000" },
  ]);
  assert.deepEqual(requests.map((query) => query.after), [undefined, "cursor-after-int_b-0000"]);
  assert.deepEqual(out.data, { cursor: "cursor-after-int_b-0000", received: 2 });
});

test("relo listen --since takes a cursor or a time, and --once makes one round", async () => {
  const byCursor = harness([]);
  await execute(["listen", "--once", "--since", "cursor-from-yesterday-0000"], byCursor.overrides);
  assert.deepEqual(byCursor.requests, [{ after: "cursor-from-yesterday-0000", since: undefined, timeoutSeconds: 60 }]);
  const byTime = harness([]);
  await execute(["listen", "--once", "--since", "2026-10-13T09:00:00Z"], byTime.overrides);
  assert.deepEqual(byTime.requests, [{ after: undefined, since: "2026-10-13T09:00:00Z", timeoutSeconds: 60 }]);
  await assert.rejects(execute(["listen", "--since", "yesterday"], harness([]).overrides), /--since takes a cursor/);
});

test("relo listen rides out network failures but stops when the login is gone", async () => {
  const flaky = harness([new NetworkError("down"), new NetworkError("down"), { answers: [answered("int_c")], cursor: "cursor-after-int_c-0000" }]);
  await execute(["listen", "--timeout", "3m"], flaky.overrides);
  assert.deepEqual(flaky.sleeps.slice(0, 2), [2_000, 4_000]);
  assert.equal(flaky.lines[0].id, "int_c");
  await assert.rejects(execute(["listen"], harness([new AuthError("revoked")]).overrides), (error) => error.exitCode === 3);
  await assert.rejects(execute(["listen"], harness([new ApiError("This login was revoked.",
    { status: 401, code: "CREDENTIAL_REVOKED" })]).overrides), (error) => error.exitCode === 3 && error.code === "CREDENTIAL_REVOKED");
});
