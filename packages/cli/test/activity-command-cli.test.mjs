import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execute } from "../src/cli.mjs";
import { NetworkError } from "../src/errors.mjs";
const id = "act_11111111-1111-4111-8111-111111111111";
const config = { apiUrl: "https://fixture.invalid",token: "fixture-token",principal: { id: "fixture" } };
const delivery = { eligibleDevices: 1,durableCommands: 1,apnsJobs: 0 };
async function fixture(run) { const root = await mkdtemp(join(tmpdir(),"relo-cli-capture-")); try { await run(root); } finally { await rm(root,{ recursive: true,force: true }); } }
const dependencies = (root,client,more = {}) => ({ configPath: () => "fixture",loadConfig: async () => config,
  clientFactory: () => client,activityCaptureDirectory: root,now: () => Date.parse("2026-10-01T00:00:00.000Z"),...more });
test("a timed-out start retries the original occurrence after a new CLI process invocation",() => fixture(async root => {
  const requests = [];
  const client = { startActivity: async (body,key) => { requests.push({ body,key }); if(requests.length === 1) throw new NetworkError("timeout"); return { activity: { id },delivery }; } };
  const args = ["activity","start","--title","Run","--status","Applying migrations","--source","Fixture","--project","Fixture","--topic","Fixture","--idempotency-key","one-start"];
  await assert.rejects(execute(args,dependencies(root,client)),/timeout/);
  await execute(args,dependencies(root,client,{ now: () => Date.parse("2026-10-02T00:00:00.000Z") }));
  assert.deepEqual(requests[1],requests[0]);assert.equal(requests[1].body.occurredAt,"2026-10-01T00:00:00.000Z");
}));
test("a retried handle-free update cannot target a replacement activity or a newer sequence",() => fixture(async root => {
  const requests = [];let reads = 0;
  const client = { getActivity: async target => { assert.match(target,/^work-[0-9a-f]{24}$/u);reads++;return { activity: { id,sequence: 7 } }; },
    updateActivity: async (target,body,key) => { requests.push({ target,body,key }); if(requests.length === 1) throw new NetworkError("timeout");return { activity: { id },delivery }; } };
  const args = ["activity","update","--status","Applying migrations","--source","Fixture","--project","Fixture","--topic","Fixture","--idempotency-key","one-update"];
  await assert.rejects(execute(args,dependencies(root,client)),/timeout/);
  client.getActivity = () => { throw new Error("must not select a replacement"); };
  await execute(args,dependencies(root,client,{ now: () => Date.parse("2026-10-02T00:00:00.000Z") }));
  assert.equal(reads,1);assert.deepEqual(requests[1],requests[0]);assert.equal(requests[0].target,id);assert.equal(requests[0].body.ifSequence,7);
}));
test("an exact-version notification producer sends immediately without an extra status request",() => fixture(async root => {
  let sent;
  const client = { endActivity: async (target,body) => { sent = { target,body };return { activity: { id },delivery }; },
    getActivity: () => { throw new Error("unneeded request"); } };
  await execute(["activity","end",id,"--stdin","--idempotency-key","one-end"],dependencies(root,client,{
    readStdinJson: async () => ({ ifSequence: 4,occurredAt: "2026-09-30T23:59:00.000Z" }),
  }));
  assert.equal(sent.target,id);assert.equal(sent.body.ifSequence,4);assert.equal(sent.body.occurredAt,"2026-09-30T23:59:00.000Z");
}));
test("failed protected capture stops before any network mutation",() => fixture(async root => {
  const blocked = join(root,"blocked");await writeFile(blocked,"preserve");
  const client = { startActivity: () => { throw new Error("mutation must not start"); } };
  await assert.rejects(execute(["activity","start","--title","Run","--status","Applying migrations","--source","Fixture","--project","Fixture","--topic","Fixture"],
    dependencies(blocked,client)),/could not be preserved/);
}));


test("a producer retry cannot rebase its saved sequence after observing newer state",() => fixture(async root => {
  const requests = [];let sequence = 4;
  const client = { updateActivity: async (target,body) => { requests.push({ target,body });return { activity: { id },delivery }; } };
  const args = ["activity","update",id,"--stdin","--idempotency-key","captured-precondition"];
  const deps = dependencies(root,client,{ readStdinJson: async () => ({ status: "Applying migrations",ifSequence: sequence }) });
  await execute(args,deps);sequence = 9;await execute(args,deps);
  assert.deepEqual(requests[1],requests[0]);assert.equal(requests[1].body.ifSequence,4);
}));
