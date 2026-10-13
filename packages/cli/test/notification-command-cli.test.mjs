import assert from "node:assert/strict";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execute } from "../src/cli.mjs";
import { NetworkError } from "../src/errors.mjs";
const config={apiUrl:"https://fixture.invalid",token:"notification-capture-fixture"};
const identity=["--source","Fixture","--project","Fixture","--topic","Fixture"];
const delivery={eligibleDevices:1,durableCommands:1,apnsJobs:0};
async function fixture(run){const root=await mkdtemp(join(tmpdir(),"relo-notification-capture-"));try{await run(root);}finally{await rm(root,{recursive:true,force:true});}}
const dependencies=(root,client,more={})=>({configPath:()=>"fixture",loadConfig:async()=>config,clientFactory:()=>client,
  activityCaptureDirectory:root,now:()=>Date.parse("2026-10-01T00:00:00.000Z"),...more});
for(const kind of ["notice"]){
  test(`${kind} default chronology survives a failed send and a later CLI invocation`,()=>fixture(async root=>{
    const sent=[];
    const send=async(body,key)=>{sent.push({body,key});if(sent.length===1)throw new NetworkError("timeout");return {delivery};};
    const client={sendNotification:send,createInteraction:send};
    const args=["notify",kind==="notice"?"send":"ask","Fixture",...identity,"--idempotency-key","immutable-default",
      ...(kind==="notice"?[]:["--yes-no","--expires-in","30s"]),...(kind==="live-decision"?["--live-activity"]:[])];
    await assert.rejects(execute(args,dependencies(root,client)),/timeout/);
    await execute(args,dependencies(root,client,{now:()=>Date.parse("2026-10-02T00:00:00.000Z")}));
    assert.deepEqual(sent[1],sent[0]);assert.equal(sent[0].body.relevance?.occurredAt,"2026-10-01T00:00:00.000Z");
    assert.equal(sent[0].body.relevance.policy.kind,kind==="notice"?"notice":"decision");
    if(kind!=="notice")assert.equal(sent[0].body.relevance.policy.actionSeconds,30);
  }));
}
test("notification capture failure sends no request and preserves the failed file",()=>fixture(async root=>{
  const blocked=join(root,"blocked");await writeFile(blocked,"preserve");let sent=false;
  await assert.rejects(execute(["notify","send","Fixture",...identity],dependencies(blocked,{sendNotification:()=>{sent=true;}})),
    error=>error.code==="PRODUCER_CAPTURE_UNAVAILABLE");assert.equal(sent,false);
}));
test("notification key reuse with changed intent fails before a second send",()=>fixture(async root=>{
  let sent=0;const client={sendNotification:async()=>{sent++;return {delivery};}};
  const args=["notify","send","First",...identity,"--idempotency-key","one-intent"];
  await execute(args,dependencies(root,client));args[2]="Changed";
  await assert.rejects(execute(args,dependencies(root,client)),/different command/);assert.equal(sent,1);
}));
