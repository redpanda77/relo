import assert from "node:assert/strict";
import test from "node:test";
import { execute, run, EXIT, cardKey } from "../src/cli.mjs";
import { cardDependencies, fakeCards } from "./fake-cards.mjs";

const session = { CLAUDE_CODE_SESSION_ID: "session-1234" };
const topic = ["--topic", "Release 0.7.57"];

test("inside an agent session every command lands on that session's single card", async () => {
  const { client, cards, calls } = fakeCards();
  const deps = cardDependencies(client, { env: session });
  await execute(["activity", "start", "--title", "Deploying", "--status", "Building", "--progress", "0.2", ...topic], deps);
  await execute(["activity", "start", "--title", "Deploying", "--status", "Restarted", ...topic], deps);
  await execute(["activity", "update", "--status", "Pushing image", "--progress", "0.7"], deps);
  await execute(["ask", "Deploy to production?", "--approval"], deps);
  await execute(["activity", "end", "--status", "Live"], deps);
  assert.equal(cards.size, 1, "one card for the whole session");
  const [card] = cards.values();
  assert.match(card.key, /^session-claude-code-[0-9a-f]{24}$/u);
  assert.equal(card.state, "ended");
  assert.ok(calls.filter((call) => call.op === "start").every((call) => call.body.acquireMode === "ensure"));
  assert.equal(calls.find((call) => call.op === "ask").id, card.id);
});

test("outside a session the card is source › project › topic", async () => {
  const { client, cards } = fakeCards();
  const deps = cardDependencies(client);
  await execute(["activity", "start", "--title", "A", "--status", "Working", ...topic], deps);
  await execute(["activity", "start", "--title", "A", "--status", "Working", ...topic], deps);
  await execute(["activity", "start", "--title", "B", "--status", "Working", "--topic", "Homepage"], deps);
  assert.equal(cards.size, 2);
  assert.equal(cardKey({ context: { providerName: "Codex", project: "relo", threadName: "X" }, env: {} }),
    cardKey({ context: { providerName: "Codex", project: "relo", threadName: "X" }, env: {} }));
  await assert.rejects(execute(["activity", "update", "--status", "Working"], deps),
    (error) => error.exitCode === EXIT.USAGE && /--topic/.test(error.details.hint));
  await execute(["activity", "update", "--status", "Testing", ...topic], deps);
});

test("ask with no running card starts one for the question and ends it once answered", async () => {
  const { client, cards, calls } = fakeCards({ answer: "approved", answerAfterPolls: 2 });
  const output = await execute(["ask", "Ship 0.7.57?", "--approval", ...topic], cardDependencies(client));
  assert.equal(output.exitCode, EXIT.OK);
  assert.equal(output.data.interaction.state, "approved");
  assert.equal(output.data.card.createdForQuestion, true);
  const [card] = cards.values();
  assert.equal(calls.find((call) => call.op === "start").body.status, "Needs you");
  assert.equal(card.state, "ended");
  assert.equal(calls.find((call) => call.op === "end").body.status, "Approved");
});

test("a denial exits 5 and an agent session keeps its card as the live view", async () => {
  const { client, cards } = fakeCards({ answer: "denied" });
  await assert.rejects(execute(["ask", "Ship 0.7.57?", "--approval", ...topic], cardDependencies(client, { env: session })),
    (error) => error.exitCode === EXIT.NEGATIVE);
  assert.equal([...cards.values()][0].state, "active");
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
    ["activity", "ensure", "--title", "A", "--status", "B"]]) {
    await assert.rejects(execute([...removed, ...topic], deps), (error) => error.exitCode === EXIT.USAGE);
  }
});

test("notify is one-shot: it cannot ask", async () => {
  const { client } = fakeCards();
  await assert.rejects(execute(["notify", "Ready", "--approval", ...topic], cardDependencies(client)),
    /not valid for this command/);
});

test("with Live Activities off, ask falls back to a question answered in Relo and leaves no card", async () => {
  const { client, cards, calls } = fakeCards();
  const start = client.startActivity;
  client.startActivity = async (...args) => ({ ...(await start(...args)), delivery: { eligibleDevices: 0, durableCommands: 0, apnsJobs: 0 } });
  let asked;
  client.createInteraction = async (body) => { asked = body;
    return { interaction: { id: "int_fallback", state: "pending" }, delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 } }; };
  client.waitForInteraction = async (id) => ({ interaction: { id, state: "approved" } });
  const output = await execute(["ask", "Ship it?", "--approval", ...topic], cardDependencies(client));
  assert.equal(output.exitCode, EXIT.OK);
  assert.equal(output.data.fallback, "answer_in_app");
  assert.equal(asked.answerInApp, true);
  assert.equal(asked.type, "approval");
  assert.equal([...cards.values()][0].state, "ended", "the empty card is ended at once");
  assert.equal(calls.some((call) => call.op === "ask"), false);
});

test("an update or start while a question waits is held for after the answer, and succeeds", async () => {
  const { client } = fakeCards();
  const deps = cardDependencies(client, { env: session });
  await execute(["activity", "start", "--title", "Deploying", "--status", "Building", ...topic], deps);
  const held = (payload) => ({ ...payload, activity: { ...payload.activity, status: "Needs you",
    presentation: { behavior: { type: "yes_no" } } }, delivery: { eligibleDevices: 1, durableCommands: 0, apnsJobs: 0 } });
  const update = client.updateActivity, start = client.startActivity;
  client.updateActivity = async (...args) => held(await update(...args));
  client.startActivity = async (...args) => held(await start(...args));
  for (const command of [["activity", "update", "--status", "Testing"],
    ["activity", "start", "--title", "Deploying", "--status", "Testing", ...topic]]) {
    const output = await execute(command, deps);
    assert.equal(output.exitCode, EXIT.OK);
    assert.equal(output.data.heldForQuestion, true);
  }
});
