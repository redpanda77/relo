import "./hermetic-env.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdtemp,readFile,readdir,rm,stat,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureActivityCommand } from "../src/messages/activity-journal.mjs";
const target = "act_11111111-1111-4111-8111-111111111111";
const base = { config: { apiUrl: "https://fixture.invalid",token: "never-persist-token" },key: "stable-operation",operation: "update",
  selector: "current",body: { status: "never-persist-content" },occurredAt: "2026-10-01T00:00:00.000Z",resolve: async () => ({ target,ifSequence: 2 }) };
async function fixture(run) { const root = await mkdtemp(join(tmpdir(),"relo-capture-")); try { await run(root); } finally { await rm(root,{ recursive: true,force: true }); } }
test("restart and concurrent capture retain one original time, target and exact sequence",() => fixture(async root => {
  const captures = await Promise.all(Array.from({ length: 12 },(_,i) => captureActivityCommand({ ...base,
    occurredAt: new Date(Date.parse(base.occurredAt)+i*1000).toISOString(),resolve: async () => ({ target,ifSequence: i }) },{ root })));
  assert.ok(captures.every(record => JSON.stringify(record) === JSON.stringify(captures[0])));
  const retry = await captureActivityCommand({ ...base,occurredAt: "2026-10-02T00:00:00.000Z",resolve: () => { throw new Error("must not reselect"); } },{ root });
  assert.deepEqual(retry,captures[0]);
  const shard = join(root,(await readdir(root))[0]), file = join(shard,(await readdir(shard))[0]);
  const bytes = await readFile(file,"utf8");
  for (const sentinel of [base.config.token,base.config.apiUrl,base.body.status]) assert.ok(!bytes.includes(sentinel));
  assert.equal((await stat(file)).mode & 0o777,0o600);
}));
test("changed intent conflicts while malformed bytes survive without a fresh capture",() => fixture(async root => {
  await captureActivityCommand(base,{ root });
  await assert.rejects(captureActivityCommand({ ...base,body: { status: "different" } },{ root }),/different command/);
  const shard = join(root,(await readdir(root))[0]), file = join(shard,(await readdir(shard))[0]);
  await writeFile(file,"broken",{ mode: 0o600 });
  await assert.rejects(captureActivityCommand(base,{ root }),/could not be preserved/);
  assert.equal(await readFile(file,"utf8"),"broken");
}));
test("credential/origin changes are separate scopes and starts require no target lookup",() => fixture(async root => {
  const first = await captureActivityCommand({ ...base,operation: "start",resolve: () => { throw new Error("unneeded"); } },{ root });
  assert.equal(first.target,null);assert.equal(first.ifSequence,null);
  const changed = await captureActivityCommand({ ...base,config: { ...base.config,apiUrl: "https://other.invalid" } },{ root });
  assert.equal(changed.target,target);assert.equal(changed.ifSequence,2);
}));


test("separate processes choose the same immutable capture",() => fixture(async root => {
  const moduleURL = new URL("../src/messages/activity-journal.mjs",import.meta.url).href;
  const code = `import {captureActivityCommand} from ${JSON.stringify(moduleURL)};
const base = JSON.parse(process.argv[1]);const root=process.argv[2];
const record=await captureActivityCommand({...base,resolve:async()=>({target:${JSON.stringify(target)},ifSequence:Number(process.argv[3])})},{root});console.log(JSON.stringify(record));`;
  const results = await Promise.all([1,2,3,4].map(value => promisify(execFile)(process.execPath,["--input-type=module","-e",code,JSON.stringify(base),root,String(value)])));
  assert.ok(results.every(result => result.stdout === results[0].stdout));
}));
