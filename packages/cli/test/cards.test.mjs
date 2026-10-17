import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { execute } from "../src/cli.mjs";
import { EXIT } from "../src/shared/errors.mjs";
import { cardKey } from "../src/messages/card-context.mjs";
import { producerPathKey } from "../src/script/producer.mjs";
import { cardDependencies, fakeCards } from "./fake-cards.mjs";

const session = { CLAUDE_CODE_SESSION_ID: "session-1234" };
const topic = ["--topic", "Release 0.7.57"];

test("outside a session the card is source › project › topic", async () => {
  const same = { providerName: "Codex", project: "relo", threadName: "X" };
  assert.equal(cardKey({ context: same, env: {} }), cardKey({ context: same, env: {} }));
  assert.notEqual(cardKey({ context: same, env: {} }), cardKey({ context: { ...same, threadName: "Y" }, env: {} }));
  assert.equal(cardKey({ context: { providerName: "Codex", project: "relo" }, env: {} }), undefined, "no topic, no card");
});

test("invariant: a question never creates a card; with none running it is a notification with answer buttons", async () => {
  for (const env of [{}, session]) {
    const { client, cards, calls } = fakeCards({ answer: "approved", answerAfterPolls: 2 });
    const output = await execute(["ask", "Ship 0.7.57?", "--approval", ...topic], cardDependencies(client, { env }));
    assert.equal(output.exitCode, EXIT.OK);
    assert.equal(output.data.interaction.state, "approved");
    assert.equal(output.data.fallback, "notification");
    assert.equal(cards.size, 0, "no card was started for the question");
    assert.deepEqual(calls.filter((call) => ["start", "update", "end"].includes(call.op)), []);
    const question = calls.find((call) => call.op === "question");
    assert.equal(question.body.type, "approval");
    assert.equal(question.body.answerInApp, undefined, "the notification carries the answer buttons");
  }
});

test("--no-wait returns the pending question at once", async () => {
  const { client, calls } = fakeCards();
  const output = await execute(["ask", "Ship?", "--yes-no", "--no-wait", ...topic], cardDependencies(client));
  assert.equal(output.data.interaction.state, "pending");
  assert.equal(calls.some((call) => call.op === "end"), false);
});

test("typed replies and the old question commands are gone", async () => {
  const deps = cardDependencies(fakeCards().client);
  await assert.rejects(execute(["ask", "Why?", "--type", "text", ...topic], deps),
    (error) => error.exitCode === EXIT.USAGE && /--approval .* --yes-no/.test(error.message));
  for (const removed of [["notify", "ask", "Ship?", "--approval"], ["activity", "wait", "act_1", "Ship?", "--approval"],
    ["activity", "ensure", "--title", "Nightly export", "--status", "B"]]) {
    await assert.rejects(execute([...removed, ...topic], deps), (error) => error.exitCode === EXIT.USAGE);
  }
});

test("notify is one-shot: it cannot ask", async () => {
  const { client } = fakeCards();
  await assert.rejects(execute(["notify", "Ready", "--approval", ...topic], cardDependencies(client)),
    /not valid for this command/);
});


test("a script asks on its own work's card: the producer's open work, found by its RELO_SESSION key", async () => {
  const { client, calls } = fakeCards();
  const { activity } = await client.startActivity({ title: "Nightly export", status: "Running" }, "k");
  const asked = [];
  client.request = async (method, path, options) => {
    asked.push([method, path, options?.query?.state]);
    return { works: [{ id: "wrk_1", lifecycle: "open", card: { id: activity.id, state: "active" } }] };
  };
  const out = await execute(["ask", "Ship the export?", "--approval", "--no-wait", ...topic], cardDependencies(client, { env: { RELO_SESSION: "nightly" } }));
  assert.equal(out.data.card.id, activity.id, "on the work's card, not a notification");
  assert.equal(calls.at(-1).op, "ask");
  assert.deepEqual(asked, [["GET", `/api/producers/${producerPathKey("nightly")}/works`, "open"]]);
});
