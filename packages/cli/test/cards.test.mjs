import assert from "node:assert/strict";
import test from "node:test";
import { execute, EXIT, cardKey } from "../src/cli.mjs";
import { cardDependencies, fakeCards } from "./fake-cards.mjs";

const session = { CLAUDE_CODE_SESSION_ID: "session-1234" };
const topic = ["--topic", "Release 0.7.57"];

test("inside an agent session every command lands on that session's single card", async () => {
  const { client, cards, calls } = fakeCards();
  const deps = cardDependencies(client, { env: session });
  await execute(["activity", "start", "--title", "Deploying", "--status", "Building", "--progress", "0.2", ...topic], deps);
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

test("invariant: a second start never changes the running card's title, topic or steps", async () => {
  const { client, cards, calls } = fakeCards();
  const deps = cardDependencies(client, { env: session });
  await execute(["activity", "start", "--title", "Deploying", "--status", "Building", "--steps", "Build,Test,Ship", ...topic], deps);
  const before = structuredClone([...cards.values()][0]);
  const starts = calls.filter((call) => call.op === "start").length;
  const again = await execute(["activity", "start", "--title", "Something else", "--status", "Phase 2", "--steps", "Draft notes,Publish notes",
    "--topic", "A different topic"], deps);
  assert.equal(again.exitCode, EXIT.OK, "a repeat start continues the running card");
  assert.equal(again.data.disposition, "continuing");
  assert.equal(again.data.card.id, before.id);
  assert.match(again.data.next, /relo activity update .*--next-step/u);
  assert.match(again.data.next, /relo activity end/u);
  assert.equal(calls.filter((call) => call.op === "start").length, starts, "nothing was sent to the running card");
  assert.deepEqual([...cards.values()][0], before);
});

test("a start the server reports as an existing card continues it and leaves the card as it was", async () => {
  const { client, cards } = fakeCards();
  const start = client.startActivity;
  client.startActivity = async (...args) => ({ ...(await start(...args)), disposition: "existing" });
  const continued = await execute(["activity", "start", "--title", "A", "--status", "Working", ...topic], cardDependencies(client));
  assert.equal(continued.data.disposition, "continuing");
  assert.equal(cards.size, 1);
});

test("outside a session the card is source › project › topic", async () => {
  const { client, cards } = fakeCards();
  const deps = cardDependencies(client);
  await execute(["activity", "start", "--title", "A", "--status", "Working", ...topic], deps);
  assert.equal((await execute(["activity", "start", "--title", "A", "--status", "Working", ...topic], deps)).data.disposition, "continuing");
  await execute(["activity", "start", "--title", "B", "--status", "Working", "--topic", "Homepage"], deps);
  assert.equal(cards.size, 2);
  assert.equal(cardKey({ context: { providerName: "Codex", project: "relo", threadName: "X" }, env: {} }),
    cardKey({ context: { providerName: "Codex", project: "relo", threadName: "X" }, env: {} }));
  await assert.rejects(execute(["activity", "update", "--status", "Working"], deps),
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

test("a denial exits 5 and the work's card stays as it was", async () => {
  const { client, cards, calls } = fakeCards({ answer: "denied" });
  const deps = cardDependencies(client, { env: session });
  await execute(["activity", "start", "--title", "Deploying", "--status", "Building", ...topic], deps);
  await assert.rejects(execute(["ask", "Ship 0.7.57?", "--approval"], deps), (error) => error.exitCode === EXIT.NEGATIVE);
  assert.equal([...cards.values()][0].state, "active");
  assert.equal(calls.some((call) => call.op === "end"), false, "answering never ends the card");
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

test("a card that cannot show the question falls back to answering in Relo and is left alone", async () => {
  const { client, cards, calls } = fakeCards();
  const deps = cardDependencies(client, { env: session });
  await execute(["activity", "start", "--title", "Deploying", "--status", "Building", ...topic], deps);
  client.createActivityWait = async () => { throw Object.assign(new Error("unavailable"), { code: "ACTIVITY_TARGET_UNAVAILABLE" }); };
  let asked;
  client.createInteraction = async (body) => { asked = body;
    return { interaction: { id: "int_fallback", state: "pending" }, delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 } }; };
  client.waitForInteraction = async (id) => ({ interaction: { id, state: "approved" } });
  const output = await execute(["ask", "Ship it?", "--approval"], deps);
  assert.equal(output.exitCode, EXIT.OK);
  assert.equal(output.data.fallback, "answer_in_app");
  assert.equal(asked.answerInApp, true);
  assert.equal(asked.type, "approval");
  assert.equal([...cards.values()][0].state, "active");
  assert.equal(calls.filter((call) => call.op === "start").length, 1);
});

test("an update while a question waits is held for after the answer, and succeeds", async () => {
  const { client } = fakeCards();
  const deps = cardDependencies(client, { env: session });
  await execute(["activity", "start", "--title", "Deploying", "--status", "Building", ...topic], deps);
  const held = (payload) => ({ ...payload, activity: { ...payload.activity, status: "Needs you",
    presentation: { behavior: { type: "yes_no" } } }, delivery: { eligibleDevices: 1, durableCommands: 0, apnsJobs: 0 } });
  const update = client.updateActivity;
  client.updateActivity = async (...args) => held(await update(...args));
  const output = await execute(["activity", "update", "--status", "Testing"], deps);
  assert.equal(output.exitCode, EXIT.OK);
  assert.equal(output.data.heldForQuestion, true);
});

test("generic or repeated step names are refused with good examples; the card's own steps are left alone", async () => {
  const { client, calls } = fakeCards();
  const deps = cardDependencies(client, { env: session });
  for (const steps of ["Step 1,Step 2", "Phase 1,Build", "todo,Ship", "tbd,Ship", "misc,Ship", "next,Ship", "Build,3", "Go,Ship",
    "Build,build", "Stage 2,Ship", "Task,Ship"]) {
    await assert.rejects(execute(["activity", "start", "--title", "Deploy", "--status", "Building", "--steps", steps, ...topic], deps),
      (error) => error.exitCode === EXIT.USAGE && /says nothing about the work|appears twice/u.test(error.message)
        && /Run migrations/u.test(error.message), steps);
  }
  assert.equal(calls.length, 0, "nothing was sent");
  await execute(["activity", "start", "--title", "Deploy", "--status", "Building", "--steps", "Build image,Run tests,Go live", ...topic], deps);
  await assert.rejects(execute(["activity", "update", "--steps", "Build image,Step 2"], deps), /says nothing/u);
  // A sealed card reads back "Step n" from the server: moving on with --next-step never trips the check.
  const sealed = { id: "act_11111111-1111-4111-8111-111111111111", state: "active", sequence: 2, presentation: { components: [{ type: "steps",
    items: [{ label: "Step 1", state: "current" }, { label: "Step 2", state: "pending" }] }] } };
  const sent = [];
  const reader = { getActivity: async () => ({ activity: sealed }),
    updateActivity: async (_id, body) => { sent.push(body); return { activity: sealed, delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 } }; } };
  await execute(["activity", "update", "--next-step"], cardDependencies(reader, { env: session }));
  assert.equal(sent[0].steps.current, 2);
});
