import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { execute } from "../src/cli.mjs";

const notice = {
  subjectKey: "independent:fixture",generation: 2,revision: 3,operation: "update",
  occurredAt: "2026-09-30T12:00:00.000Z",policy: { kind: "notice",deliverySeconds: 60 },
};
function dependencies(input, sent) {
  return {
    prepareNotificationCommand: async ({ body }) => body,
    configPath: () => "/fixture/config",loadConfig: async () => ({ principal: { name: "Fixture" } }),
    readStdinJson: async () => ({ ...input,context: { providerName: "Fixture",project: "Relo",threadName: "Relevance" } }),
    clientFactory: () => ({
      sendNotification: async (body) => { sent.push(body); return { delivery: { eligibleDevices: 1,durableCommands: 1,apnsJobs: 0 } }; },
      createInteraction: async (body) => { sent.push(body); return { delivery: { eligibleDevices: 1,durableCommands: 1,apnsJobs: 0 } }; },
    }),
  };
}

test("ordinary notice JSON preserves exact producer identity and original time",async () => {
  for (const kind of ["notice"]) {
    const relevance = { ...notice,policy: kind === "notice" ? notice.policy
      : { kind: "decision",actionSeconds: 30,deliverySeconds: 15 } };
    const sent = [];
    const args = kind === "notice" ? ["notify","send","Fixture"]
      : ["notify","ask","Fixture","--yes-no","--expires-in","30s"];
    await execute([...args,"--stdin"],dependencies({ relevance },sent));
    assert.deepEqual(sent[0].relevance,relevance);
  }
});

test("invalid authority, kind, version, date, and lifetime cannot silently lose relevance",async () => {
  const invalid = [
    { ...notice,accountId: "other-account" },{ ...notice,sourceId: "other-source" },
    { ...notice,generation: Number.MAX_SAFE_INTEGER+1 },{ ...notice,revision: 0 },
    { ...notice,occurredAt: "now" },{ ...notice,policy: { kind: "decision" } },
    { ...notice,policy: { kind: "notice",deliverySeconds: 901 } },
    { ...notice,policy: { kind: "notice",deliverySeconds: -1 } },
  ];
  for (const relevance of invalid) {
    const sent = [];
    await assert.rejects(execute(["notify","send","Fixture","--stdin"],dependencies({ relevance },sent)),/relevance/);
    assert.equal(sent.length,0);
  }
});

test("operational policies and explicit resolution pass through without losing original chronology",async()=>{
  for(const policy of [{kind:"progress"},{kind:"progress",heartbeat:{intervalSeconds:10,lastHeartbeatAt:notice.occurredAt}},
    {kind:"incident",mode:"until_resolved"},{kind:"incident",mode:"lease",leaseUntil:notice.occurredAt}]){
    const relevance={...notice,policy,...(policy.kind==="incident"?{status:"resolved"}:{})},sent=[];
    await execute(["notify","send","Fixture","--stdin"],dependencies({relevance},sent));
    assert.deepEqual(sent[0].relevance,relevance);
  }
});
test("malformed operational policy cannot become an ordinary alert",async()=>{
  for(const relevance of [{...notice,status:"resolved"},{...notice,policy:{kind:"progress",heartbeat:{intervalSeconds:0,lastHeartbeatAt:notice.occurredAt}}},
    {...notice,policy:{kind:"incident",mode:"lease"}},{...notice,policy:{kind:"incident",mode:"until_resolved",leaseUntil:notice.occurredAt}},
    {...notice,policy:{kind:"incident",mode:"lease",leaseUntil:"later"}}]){
    const sent=[];await assert.rejects(execute(["notify","send","Fixture","--stdin"],dependencies({relevance},sent)),/relevance/);assert.equal(sent.length,0);
  }
});

