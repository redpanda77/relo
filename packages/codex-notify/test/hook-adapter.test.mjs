import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { executeHook,parseHookArgs,readHookInput,runHook } from "../src/hook-adapter.mjs";

const sourceInstance = `codex-notify-${"a".repeat(32)}`;
const options = {
  reloBin: "/opt/relo",installationIdPath: "/private/codex.identity",
};

function memoryState() {
  const runs = {};
  return {
    runs,
    async get(runId) { return runs[runId] ?? null; },
    async put(entry) { runs[entry.lifecycle.runId] = structuredClone(entry); return entry; },
    async activeForThread(thread) { return Object.values(runs).filter((entry) => entry.origin.thread === thread && !entry.terminal); },
  };
}

function event(name,extra = {}) {
  return {
    session_id: "thr_private_raw",turn_id: "turn_private_raw",cwd: "/Users/test/Project",
    hook_event_name: name,...extra,
  };
}

function harness() {
  const calls = [];
  let sequence = 0;
  let state = "active";
  let context;
  const spawnImpl = (command,args,spawnOptions) => {
    const input = JSON.parse(spawnOptions.input);
    calls.push({ command,args,input });
    const operation = args[1];
    if (operation === "status") {
      return { status: 0,stdout: JSON.stringify({ ok: true,command: "activity.status",data: {
        found: true,activity: { id: "act_123",generation: 1,sequence,state,status: "Working",context },
      } }),stderr: "" };
    }
    if (operation === "ensure" || operation === "update") context = input.context ?? context;
    if (operation === "update") sequence += 1;
    if (operation === "end") { sequence += 1; state = "ended"; }
    return { status: 0,stdout: JSON.stringify({ ok: true,command: `activity.${operation}`,data: {
      activity: { id: "act_123",generation: 1,sequence,state },
    } }),stderr: "" };
  };
  return { calls,spawnImpl };
}

async function semanticContext(input) {
  return {
    providerName: "Codex",producerKind: "agent",
    providerThreadId: input.session_id,providerWorkItemId: input.turn_id,
    threadName: "Audit live activity delivery",threadNameSource: "provider",
    ...(input.prompt ? { taskTitle: "Implement coherent task grouping.",taskTitleSource: "prompt_summary" } : {}),
  };
}

test("parses only absolute secret-free hook configuration",() => {
  assert.deepEqual(parseHookArgs([
    "--relo-bin","/opt/relo","--installation-id-path","/private/codex.identity",
  ]),options);
  assert.throws(() => parseHookArgs(["--relo-bin","relo","--installation-id-path","/private/id"]),/absolute/);
  assert.throws(() => parseHookArgs(["--token","secret"]),/Unknown hook option/);
});

test("an upgraded hook enriches an already-active legacy run without creating another activity",async () => {
  const state = memoryState();
  const runtime = harness();
  const input = event("UserPromptSubmit",{ prompt: "Implement coherent task grouping." });
  const base = {
    state,spawnImpl: runtime.spawnImpl,loadInstallationIdentity: async () => sourceInstance,now: () => 123,
  };
  await executeHook(options,input,{ ...base,resolveCodexContext: async () => ({}) });
  await executeHook(options,input,{ ...base,resolveCodexContext: semanticContext });

  assert.deepEqual(runtime.calls.map((call) => call.args.slice(0,2)),[
    ["activity","ensure"],["activity","status"],["activity","update"],
  ]);
  const patch = runtime.calls[2].input;
  assert.equal(patch.progress,undefined);
  assert.equal(patch.status,"Working");
  assert.equal(patch.context.providerThreadId,"thr_private_raw");
  assert.equal(patch.context.providerWorkItemId,"turn_private_raw");
  assert.equal(patch.context.threadName,"Audit live activity delivery");
  assert.equal(patch.context.taskTitle,"Implement coherent task grouping.");
});

test("accepts large PostToolUse envelopes without forwarding their tool result",async () => {
  const input = event("PostToolUse",{
    tool_name: "view_image",tool_response: "x".repeat(2 * 1024 * 1024),
  });
  const parsed = await readHookInput(Readable.from([JSON.stringify(input)]));
  assert.equal(parsed.hook_event_name,"PostToolUse");
  assert.equal(parsed.session_id,input.session_id);
});

test("maps one Codex turn to non-measured lifecycle phases, lease renewal, and exact end",async () => {
  const state = memoryState();
  const runtime = harness();
  const dependencies = {
    state,spawnImpl: runtime.spawnImpl,loadInstallationIdentity: async () => sourceInstance,
    resolveCodexContext: semanticContext,now: () => 123,
  };
  await executeHook(options,event("UserPromptSubmit",{ prompt: "Implement coherent task grouping." }),dependencies);
  await executeHook(options,event("PostToolUse",{ tool_name: "apply_patch",tool_input: { command: "secret" } }),dependencies);
  await executeHook(options,event("PostToolUse",{ tool_name: "Bash",tool_input: { command: "token=secret" } }),dependencies);
  await executeHook(options,event("PermissionRequest",{ tool_name: "Bash",tool_input: { command: "private" } }),dependencies);
  await executeHook(options,event("PostToolUse",{ tool_name: "Bash" }),dependencies);
  await executeHook(options,event("Stop",{ last_assistant_message: "Finished successfully." }),dependencies);

  assert.deepEqual(runtime.calls.map((call) => call.args.slice(0,2)),[
    ["activity","ensure"],["activity","status"],["activity","update"],
    ["activity","status"],["activity","heartbeat"],["activity","status"],
    ["activity","update"],["activity","status"],["activity","update"],
    ["activity","status"],["activity","end"],
  ]);
  assert.deepEqual(runtime.calls.filter((call) => call.args[1] === "update").map((call) => call.input.status),[
    "Working","Waiting for approval","Working",
  ]);
  assert.equal(runtime.calls.filter((call) => call.args[1] === "update")
    .every((call) => call.input.context.project === "Project"
      && call.input.context.threadName === "Audit live activity delivery"
      && call.input.context.taskTitle === "Implement coherent task grouping."),true);
  assert.equal(runtime.calls.every((call) => !("progress" in call.input)),true);
  assert.equal(runtime.calls.find((call) => call.args[1] === "heartbeat")?.input.leaseAfterSeconds,3_600);
  assert.equal(runtime.calls.some((call) => JSON.stringify(call).includes("token=secret")),false);
  assert.equal(runtime.calls[0].input.context.providerThreadId,"thr_private_raw");
  assert.equal(runtime.calls[0].input.context.providerWorkItemId,"turn_private_raw");
  assert.match(runtime.calls[0].input.lifecycle.runId,/^codex-run-[a-f0-9]{40}$/u);
  assert.equal(runtime.calls[0].input.title,"Codex · Project");
  assert.equal(runtime.calls[0].input.context.providerName,"Codex");
  assert.equal(runtime.calls[0].input.context.threadName,"Audit live activity delivery");
  assert.equal(runtime.calls[0].input.context.taskTitle,"Implement coherent task grouping.");
  assert.equal("style" in runtime.calls[0].input,false);
  assert.equal("symbol" in runtime.calls[0].input,false);
  assert.equal("accentColor" in runtime.calls[0].input,false);
  assert.equal("ifSequence" in runtime.calls[2].input,false);
  assert.equal("ifSequence" in runtime.calls[10].input,false);
  assert.equal(Object.values(state.runs)[0].terminal,true);
});

test("starts with nonempty project, thread, and task fallbacks when a lifecycle hook arrives out of order",async () => {
  const state = memoryState();
  const runtime = harness();
  await executeHook(options,event("PostToolUse"),{
    state,spawnImpl: runtime.spawnImpl,loadInstallationIdentity: async () => sourceInstance,
  });
  const context = runtime.calls[0].input.context;
  assert.equal(context.project,"Project");
  assert.equal(context.threadName,"Codex task");
  assert.equal(context.threadNameSource,"fallback");
  assert.equal(context.taskTitle,"Agent work");
  assert.equal(context.taskTitleSource,"fallback");
});

test("Stop emits valid empty JSON even when lifecycle delivery fails",async () => {
  const stdout = [];
  const code = await runHook([
    "--relo-bin","/opt/relo","--installation-id-path","/private/codex.identity",
  ],{
    stdout: (line) => stdout.push(line), stderr: () => {},
  },{
    readInput: async () => event("Stop"),
    loadInstallationIdentity: async () => { throw new Error("identity unavailable"); },
  });
  assert.equal(code,3);
  assert.deepEqual(stdout,["{}"]);
});

test("unsupported hook events are ignored", async () => {
  const result = await executeHook(options,event("PreCompact"),{
    state: memoryState(),loadInstallationIdentity: async () => sourceInstance,
  });
  assert.equal(result.event,"ignored");
});

test("SessionEnd attempts to close every locally active turn instead of leaving older runs hanging",async () => {
  const state = memoryState();
  const runtime = harness();
  const dependencies = {
    state,spawnImpl: runtime.spawnImpl,loadInstallationIdentity: async () => sourceInstance,
    resolveCodexContext: semanticContext,
  };
  await executeHook(options,event("UserPromptSubmit",{ turn_id: "turn-one" }),dependencies);
  await executeHook(options,event("UserPromptSubmit",{ turn_id: "turn-two" }),dependencies);
  await executeHook(options,event("SessionEnd",{ turn_id: undefined }),dependencies);
  assert.equal(runtime.calls.filter((call) => call.args[1] === "end").length,2);
  assert.equal(runtime.calls.filter((call) => call.args[1] === "end")
    .every((call) => !("progress" in call.input)),true);
});
