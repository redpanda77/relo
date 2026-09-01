import assert from "node:assert/strict";
import test from "node:test";
import { instructionTitle,resolveCodexContext } from "../src/codex-context.mjs";

test("derives a bounded instruction title without leaking credentials or paths",() => {
  const title = instructionTitle("Implement grouping in /Users/test/project with token=super-secret-value. Then verify it.");
  assert.equal(title,"Implement grouping in with Then verify it.");
  assert.equal(title.includes("/Users"),false);
  assert.equal(title.includes("super-secret-value"),false);
});

test("combines hook identity with the local Codex task name",async () => {
  const context = await resolveCodexContext({
    session_id: "019fe2d8-9b96-7f03-8b2c-83101432f6a4",
    turn_id: "turn-42",
    prompt: "Group this instruction under the current task.",
  },{
    readThread: async () => ({ name: "Audit live activity delivery" }),
  });
  assert.deepEqual(context,{
    providerName: "Codex",producerKind: "agent",
    providerThreadId: "019fe2d8-9b96-7f03-8b2c-83101432f6a4",
    providerWorkItemId: "turn-42",
    threadName: "Audit live activity delivery",threadNameSource: "provider",
    taskTitle: "Group this instruction under the current task.",taskTitleSource: "prompt_summary",
  });
});

test("uses the bounded instruction as a useful thread fallback when the provider has no task name",async () => {
  const context = await resolveCodexContext({
    session_id: "019fe2d8-9b96-7f03-8b2c-83101432f6a4",
    turn_id: "turn-43",
    prompt: "Repair the authorization completion experience.",
  },{
    readThread: async () => null,
  });
  assert.equal(context.threadName,"Repair the authorization completion experience.");
  assert.equal(context.threadNameSource,"fallback");
  assert.equal(context.taskTitle,"Repair the authorization completion experience.");
  assert.equal(context.taskTitleSource,"prompt_summary");
});
