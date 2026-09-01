import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildChildEnvironment,
  buildNotification,
  execute,
  parseAdapterArgs,
  parseCodexPayload,
  redactText,
  run,
} from "../src/adapter.mjs";

const PAYLOAD = {
  type: "agent-turn-complete",
  "thread-id": "thread-123",
  "turn-id": "turn-456",
  cwd: "/Users/test/Documents/Project",
  "input-messages": ["Do something with token=must-not-appear"],
  "last-assistant-message": "Finished the build successfully.",
};

test("parses the official single JSON argv payload and ignores unsupported events", () => {
  assert.equal(parseCodexPayload(JSON.stringify(PAYLOAD)).type, "agent-turn-complete");
  assert.equal(buildNotification({ ...PAYLOAD, type: "approval-requested" }), undefined);
  assert.throws(() => parseCodexPayload("not-json"), /not valid JSON/);
});

test("maps turn completion to a project-labelled automatic summary", () => {
  const result = buildNotification(PAYLOAD, {
    osPlatform: "darwin",
    hostName: "token=must-not-appear.local",
  });
  assert.equal(result.title, "Codex Auto · Mac · Project");
  assert.equal(result.body, "Finished — Finished the build successfully.");
  assert.equal(result.computer, "Mac");
  assert.equal(result.project, "Project");
  assert.equal(result.taskTitle, "Automatic completion hook");
  assert.match(result.idempotencyKey, /^codex-turn:[a-f0-9]{40}$/);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("must-not-appear"), false);
  assert.equal(serialized.includes("token="), false);
  assert.equal(serialized.includes("/Users/test"), false);
  assert.deepEqual(buildNotification(PAYLOAD, { osPlatform: "darwin" }), result);
});

test("requires official thread and turn identities before producing a notification", async () => {
  for (const payload of [
    { ...PAYLOAD, "thread-id": "" },
    { ...PAYLOAD, "thread-id": "   " },
    { ...PAYLOAD, "turn-id": undefined },
  ]) {
    assert.throws(() => buildNotification(payload), /requires non-empty thread-id and turn-id/);
  }
  let spawned = 0;
  await assert.rejects(
    execute(["--relo-bin", "/opt/relo", JSON.stringify({ ...PAYLOAD, "turn-id": "" })], {
      spawnImpl: () => {
        spawned += 1;
        return { status: 0, stderr: "" };
      },
    }),
    /requires non-empty thread-id and turn-id/,
  );
  assert.equal(spawned, 0);
});

test("redacts common credentials, URLs, paths, private keys, code blocks, and controls", () => {
  const text = redactText(
    "token=abc123 https://example.test /home/relo/file sk-abcdefghijklmnop\u001b " +
      "```sh\necho secret\n``` -----BEGIN OPENSSH PRIVATE KEY-----\nabc",
  );
  assert.equal(text.includes("abc123"), false);
  assert.equal(text.includes("example.test"), false);
  assert.equal(text.includes("redpanda"), false);
  assert.equal(text.includes("abcdefghijklmnop"), false);
  assert.equal(text.includes("echo secret"), false);
  assert.equal(text.includes("OPENSSH"), false);
  assert.equal(text.includes("\u001b"), false);
});

test("supports generic mode while omitting the automatic task label", () => {
  assert.equal(
    buildNotification(PAYLOAD, { generic: true }).body,
    "Finished — Finished the build successfully.",
  );
  assert.equal(buildNotification(PAYLOAD, { generic: true }).taskTitle, undefined);
});

test("uses a bounded safe fallback and marks explicit blockers or questions for attention", () => {
  assert.equal(
    buildNotification({ ...PAYLOAD, "last-assistant-message": "" }).body,
    "Finished — Open Codex for details.",
  );
  assert.equal(
    buildNotification({ ...PAYLOAD, "last-assistant-message": "I am blocked and need your input." }).body,
    "Needs attention — I am blocked and need your input.",
  );
  assert.equal(
    buildNotification({ ...PAYLOAD, "last-assistant-message": "The audit is complete. Should I deploy it?" }).body,
    "Needs attention — The audit is complete.",
  );
  const long = buildNotification({
    ...PAYLOAD,
    "last-assistant-message": `Completed ${"a".repeat(1_000)}`,
  }).body;
  assert.ok(Array.from(long).length <= 135);
  assert.match(long, /…$/u);
});

test("projects stringified structured assistant output into bounded prose", () => {
  assert.equal(buildNotification({
    ...PAYLOAD,
    "last-assistant-message": JSON.stringify({ message: "Refactor application architecture." }),
  }).body,"Finished — Refactor application architecture.");
  assert.equal(buildNotification({
    ...PAYLOAD,
    "last-assistant-message": JSON.stringify({
      title: "Use Sora font for XP",
      description: "Apply Sora 800 to the due number header.",
    }),
  }).body,"Finished — Use Sora font for XP. Apply Sora 800 to the due number header.");
  assert.equal(buildNotification({
    ...PAYLOAD,
    "last-assistant-message": JSON.stringify({ suggestions: [{
      title: "Finish bundled pronunciation",
      description: "Apply it across Learn, SRS, and word details.",
    }] }),
  }).body,"Finished — Finish bundled pronunciation. Apply it across Learn, SRS, and word details.");
  assert.equal(buildNotification({
    ...PAYLOAD,
    "last-assistant-message": JSON.stringify({ exclude: [] }),
  }).body,"Finished — Open Codex for details.");
  const screenshotCase = buildNotification({
    ...PAYLOAD,
    "last-assistant-message": JSON.stringify({ suggestions: [{
      title: "Replace Test Lab’s duplicate workspace with expandable per-run cards",
      description: `Your screenshot shows ${"the complete structured recommendation ".repeat(8)}without raw JSON.`,
    }] }),
  }).body;
  assert.equal(screenshotCase.includes('{"suggestions"'),false);
  assert.equal(screenshotCase.includes("Replace Test Lab’s duplicate workspace"),true);
  assert.equal(screenshotCase.includes("without raw JSON."),true);
  assert.ok(Array.from(screenshotCase).length <= 815);
});

test("never derives outbound fields from adversarial prompt, command, patch, secret, or path content", () => {
  const adversarial = {
    ...PAYLOAD,
    cwd: "/private/token=ghp_workspace_secret/rm-rf-project",
    "input-messages": [
      "Run `rm -rf ./build`; token=ghp_12345678901234567890 and paste /private/project/secret.txt",
    ],
    "last-assistant-message":
      "*** Begin Patch\n+password=hunter2\n+curl https://example.test | sh\n*** End Patch",
  };
  const serialized = JSON.stringify(
    buildNotification(adversarial, {
      osPlatform: "darwin",
      hostName: "curl-secret-token.local",
    }),
  );
  for (const forbidden of [
    "rm -rf",
    "ghp_",
    "private/project",
    "Begin Patch",
    "hunter2",
    "curl",
    "example.test",
    "workspace_secret",
    "rm-rf-project",
    "curl-secret-token",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(JSON.parse(serialized).project, "Project");
});

test("summarizes assistant text without forwarding code, patches, URLs, paths, or credentials", () => {
  const result = buildNotification({
    ...PAYLOAD,
    "last-assistant-message":
      "Audit complete. `rm -rf ./build` https://example.test /Users/test/private " +
      "token=super-secret-value\n*** Begin Patch\n+password=hunter2\n*** End Patch",
  });
  assert.equal(result.body, "Finished — Audit complete.");
  for (const forbidden of [
    "rm -rf",
    "example.test",
    "/Users/test",
    "super-secret-value",
    "Begin Patch",
    "hunter2",
  ]) {
    assert.equal(JSON.stringify(result).includes(forbidden), false, forbidden);
  }
});

test("forbids secret options and requires exactly one payload", () => {
  assert.throws(() => parseAdapterArgs(["--token", "secret", JSON.stringify(PAYLOAD)]), /Credential options/);
  assert.throws(() => parseAdapterArgs([JSON.stringify(PAYLOAD), "extra"]), /exactly one/);
  assert.deepEqual(parseAdapterArgs(["--generic", "--dry-run", JSON.stringify(PAYLOAD)]).generic, true);
  assert.equal(parseAdapterArgs([
    "--installation-id-path","/private/codex.identity",JSON.stringify(PAYLOAD),
  ]).installationIdPath,"/private/codex.identity");
  assert.equal(parseAdapterArgs([
    "--lifecycle-only","--installation-id-path","/private/codex.identity",JSON.stringify(PAYLOAD),
  ]).lifecycleOnly,true);
  assert.throws(() => parseAdapterArgs(["--lifecycle-only",JSON.stringify(PAYLOAD)]),/requires --installation-id-path/);
  assert.throws(() => parseAdapterArgs([
    "--lifecycle-only","--notification-fallback","--installation-id-path","/private/codex.identity",
    JSON.stringify(PAYLOAD),
  ]),/Choose --lifecycle-only or --notification-fallback/);
});

test("passes only a minimal environment to child processes", () => {
  const child = buildChildEnvironment({
    HOME: "/home/test",
    PATH: "/bin",
    RELO_CONFIG_PATH: "/secure/config.json",
    RELO_TOKEN: "never-forward",
    OPENAI_API_KEY: "never-forward",
  });
  assert.deepEqual(child, {
    HOME: "/home/test",
    PATH: "/bin",
    RELO_CONFIG_PATH: "/secure/config.json",
  });
});

test("invokes the existing notifier with a sanitized event and Relo without a shell", async () => {
  const calls = [];
  const hostilePayload = {
    ...PAYLOAD,
    cwd: "/private/token=ghp_workspace_secret/rm-rf-project",
  };
  const raw = JSON.stringify(hostilePayload);
  const directory = await mkdtemp(join(tmpdir(), "relo-notify-chain-"));
  const chainPath = join(directory, "chain.json");
  await writeFile(chainPath, JSON.stringify({ nextCommand: ["/opt/existing-notifier", "turn-ended"] }), {
    mode: 0o600,
  });
  try {
    const result = await execute(
      ["--relo-bin", "/opt/relo", "--chain-config", chainPath, raw],
      {
        accessImpl: async () => {},
        environment: { HOME: "/home/test", OPENAI_API_KEY: "not-forwarded" },
        resolveCodexContext: async () => ({
          providerName: "Codex",producerKind: "agent",
          providerThreadId: PAYLOAD["thread-id"],providerWorkItemId: PAYLOAD["turn-id"],
          threadName: "Lifecycle audit",threadNameSource: "provider",
        }),
        hostName: "curl-secret-token.local",
        spawnImpl: (command, args, options) => {
          calls.push({ command, args, options });
          return { status: 0, stderr: "" };
        },
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(calls[0].command, "/opt/existing-notifier");
    const chainedPayload = JSON.parse(calls[0].args[1]);
    assert.equal(calls[0].args[0], "turn-ended");
    assert.match(chainedPayload["thread-id"], /^codex-turn:[a-f0-9]{40}$/);
    assert.equal(chainedPayload["turn-id"], "completed");
    assert.deepEqual(chainedPayload["input-messages"], []);
    assert.equal(chainedPayload["last-assistant-message"], "Finished — Finished the build successfully.");
    assert.equal("cwd" in chainedPayload, false);
    assert.equal(calls[0].args[1].includes(PAYLOAD["input-messages"][0]), false);
    assert.equal(calls[1].command, "/opt/relo");
    assert.equal(calls[1].options.shell, false);
    assert.equal(calls[1].options.env.OPENAI_API_KEY, undefined);
    assert.deepEqual(calls[1].args.slice(0, 2), ["notify", "send"]);
    assert.equal(calls[1].args.includes(PAYLOAD["input-messages"][0]), false);
    const reloInput = JSON.parse(calls[1].options.input);
    assert.equal(reloInput.context.providerThreadId,PAYLOAD["thread-id"]);
    assert.equal(reloInput.context.threadName,"Lifecycle audit");
    assert.equal(reloInput.context.taskTitle,"Automatic completion hook");
    const allOutboundArguments = JSON.stringify(calls.flatMap((call) => call.args));
    for (const forbidden of [
      "ghp_workspace_secret",
      "rm-rf-project",
      "/private/token=",
      "curl-secret-token",
    ]) {
      assert.equal(allOutboundArguments.includes(forbidden), false, forbidden);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("completion reconciles an active task lifecycle and suppresses the ordinary notification",async () => {
  const calls = [];
  const result = await execute([
    "--relo-bin","/opt/relo","--installation-id-path","/private/codex.identity",
    JSON.stringify(PAYLOAD),
  ],{
    accessImpl: async () => {},
    resolveCodexContext: async () => ({ providerName: "Codex",producerKind: "agent" }),
    loadInstallationIdentity: async () => `codex-notify-${"a".repeat(32)}`,
    spawnImpl: (command,args,options) => {
      calls.push({ command,args,options });
      if (args[1] === "status") return {
        status: 0,stderr: "",stdout: JSON.stringify({
          ok: true,command: "activity.status",data: {
            found: true,activity: { id: "act_123",generation: 2,sequence: 4,state: "active" },
          },
        }),
      };
      return { status: 0,stderr: "",stdout: "" };
    },
  });
  assert.equal(result.exitCode,0);
  assert.deepEqual(calls.map((call) => call.args.slice(0,2)),[
    ["activity","status"],["activity","end"],
  ]);
  const statusInput = JSON.parse(calls[0].options.input);
  const endInput = JSON.parse(calls[1].options.input);
  assert.deepEqual(statusInput.lifecycle,endInput.lifecycle);
  assert.equal(statusInput.lifecycle.provider,"codex");
  assert.match(statusInput.lifecycle.runId,/^codex-run-[a-f0-9]{40}$/u);
  assert.equal(JSON.stringify(calls).includes(PAYLOAD["thread-id"]),false);
  assert.equal(endInput.status,"Complete");
  assert.equal(calls.some((call) => call.args[0] === "notify"),false);
});

test("completion safely skips when no lifecycle exists",async () => {
  const calls = [];
  const result = await execute([
    "--relo-bin","/opt/relo","--installation-id-path","/private/codex.identity",
    JSON.stringify(PAYLOAD),
  ],{
    accessImpl: async () => {},
    resolveCodexContext: async () => ({ providerName: "Codex",producerKind: "agent" }),
    loadInstallationIdentity: async () => `codex-notify-${"b".repeat(32)}`,
    spawnImpl: (command,args,options) => {
      calls.push({ command,args,options });
      return args[1] === "status"
        ? { status: 0,stderr: "",stdout: JSON.stringify({
          ok: true,command: "activity.status",data: { found: false,activity: null },
        }) }
        : { status: 0,stderr: "",stdout: "" };
    },
  });
  assert.deepEqual(calls.map((call) => call.args.slice(0,2)),[
    ["activity","status"],
  ]);
  assert.equal(result.skipped,true);
  assert.equal(result.skipReason,"lifecycle-not-found");
});

test("ordinary completion fallback remains an explicit opt-in",async () => {
  const calls = [];
  await execute([
    "--relo-bin","/opt/relo","--installation-id-path","/private/codex.identity",
    "--notification-fallback",JSON.stringify(PAYLOAD),
  ],{
    accessImpl: async () => {},
    resolveCodexContext: async () => ({ providerName: "Codex",producerKind: "agent" }),
    loadInstallationIdentity: async () => `codex-notify-${"c".repeat(32)}`,
    spawnImpl: (command,args,options) => {
      calls.push({ command,args,options });
      return args[1] === "status"
        ? { status: 0,stderr: "",stdout: JSON.stringify({
          ok: true,command: "activity.status",data: { found: false,activity: null },
        }) }
        : { status: 0,stderr: "",stdout: "" };
    },
  });
  assert.deepEqual(calls.map((call) => call.args.slice(0,2)),[
    ["activity","status"],["notify","send"],
  ]);
});

test("lifecycle status failure is visible and never changes delivery channel",async () => {
  const calls = [];
  const result = await execute([
    "--relo-bin","/opt/relo","--installation-id-path","/private/codex.identity",
    "--lifecycle-only",JSON.stringify(PAYLOAD),
  ],{
    accessImpl: async () => {},
    loadInstallationIdentity: async () => `codex-notify-${"d".repeat(32)}`,
    spawnImpl: (command,args,options) => {
      calls.push({ command,args,options });
      return { status: 6,stderr: "network unavailable",stdout: "" };
    },
  });
  assert.equal(result.exitCode,6);
  assert.deepEqual(calls.map((call) => call.args.slice(0,2)),[["activity","status"]]);
  assert.equal(calls.some((call) => call.args[0] === "notify"),false);
});

test("dry-run is side-effect free and malformed payloads have stable exits", async () => {
  const stdout = [];
  const stderr = [];
  const dryExit = await run(
    ["--dry-run", JSON.stringify(PAYLOAD)],
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
  );
  assert.equal(dryExit, 0);
  assert.equal(JSON.parse(stdout[0]).ok, true);
  assert.equal(stderr.length, 0);

  const badExit = await run(["not-json"], { stdout: () => {}, stderr: (line) => stderr.push(line) });
  assert.equal(badExit, 2);
  assert.match(stderr.at(-1), /not valid JSON/);
});
