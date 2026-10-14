import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { execute, EXIT, cardKey } from "../src/cli.mjs";
import { cardDependencies, fakeCards } from "./fake-cards.mjs";

const session = { CLAUDE_CODE_SESSION_ID: "session-1234" };
const topic = ["--topic", "Release 0.7.57"];

test("a start the server reports as an existing card continues it and leaves the card as it was", async () => {
  const { client, cards } = fakeCards();
  const start = client.startActivity;
  client.startActivity = async (...args) => ({ ...(await start(...args)), disposition: "existing" });
  const continued = await execute(["activity", "start", "--title", "Nightly export", "--status", "Applying migrations", ...topic], cardDependencies(client));
  assert.equal(continued.data.disposition, "continuing");
  assert.equal(cards.size, 1);
});

test("outside a session the card is source › project › topic", async () => {
  const { client, cards } = fakeCards();
  const deps = cardDependencies(client);
  await execute(["activity", "start", "--title", "Nightly export", "--status", "Applying migrations", ...topic], deps);
  assert.equal((await execute(["activity", "start", "--title", "Nightly export", "--status", "Applying migrations", ...topic], deps)).data.disposition, "continuing");
  await execute(["activity", "start", "--title", "Homepage redesign", "--status", "Applying migrations", "--topic", "Homepage"], deps);
  assert.equal(cards.size, 2);
  assert.equal(cardKey({ context: { providerName: "Codex", project: "relo", threadName: "X" }, env: {} }),
    cardKey({ context: { providerName: "Codex", project: "relo", threadName: "X" }, env: {} }));
  await assert.rejects(execute(["activity", "update", "--status", "Applying migrations"], deps),
    (error) => error.exitCode === EXIT.USAGE && /--topic/.test(error.details.hint));
  await execute(["activity", "update", "--status", "Testing", ...topic], deps);
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

