import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { EXIT, run } from "../src/cli.mjs";
import { openCodeBridgeInternals } from "../src/opencode-bridge.mjs";
import {
  inspectPermissionTarget,
  installPermissionTarget,
  permissionInternals,
  uninstallPermissionTarget,
} from "../src/permissions.mjs";

const RUNTIME = { nodePath: "/opt/test/node", entrypoint: "/opt/test/relo.mjs" };
function openCodeRuntime() {
  let loaded = false;
  const commands = [];
  return {
    commands,
    options: {
      ...RUNTIME,
      platform: "darwin",
      uid: 501,
      probeOpenCodeRuntime: async () => ({ functional: true, state: "protocol-ready" }),
      runCommand: async (_command, args) => {
        commands.push(args);
        if (args[0] === "bootstrap") loaded = true;
        if (args[0] === "bootout") loaded = false;
        if (args[0] === "print" && !loaded) throw new Error("not loaded");
      },
    },
  };
}
const INTERACTION_ID = "int_permission_123";
const DELIVERY = { eligibleDevices: 1, durableCommands: 1, apnsJobs: 0 };
const EXACT_PHONE_APPROVAL = Object.freeze({
  id: INTERACTION_ID,
  type: "approval",
  state: "approved",
  action: "approve",
  respondingDevice: { id: "dev_123456789012", name: "iPhone" },
  respondedAt: "2026-08-07T00:00:00.000Z",
});
const CONFIG = {
  apiUrl: "https://server.example.test",
  token: `relo_${"x".repeat(43)}`,
  path: "/private/test-config.json",
};

async function withHome(callback) {
  const home = await mkdtemp(join(tmpdir(), "relo-permissions-"));
  try {
    await callback(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

test("Codex setup preserves unrelated hooks, backs up mutations, is idempotent, and uninstalls only owned entries", async () => {
  await withHome(async (home) => {
    const path = permissionInternals.targetPath("codex", home);
    const original = {
      description: "user settings",
      hooks: {
        PermissionRequest: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "/usr/local/bin/user-hook" }],
          },
        ],
        PostToolUse: [{ hooks: [{ type: "command", command: "/usr/local/bin/audit" }] }],
      },
    };
    await writeJson(path, original);

    const installed = await installPermissionTarget("codex", { home, ...RUNTIME });
    assert.equal(installed.changed, true);
    assert.equal(await readFile(installed.backupPath, "utf8"), `${JSON.stringify(original, null, 2)}\n`);
    assert.equal((await stat(path)).mode & 0o777, 0o600);

    const settings = JSON.parse(await readFile(path, "utf8"));
    assert.equal(settings.description, "user settings");
    assert.deepEqual(settings.hooks.PostToolUse, original.hooks.PostToolUse);
    assert.equal(settings.hooks.PermissionRequest[0].hooks[0].command, "/usr/local/bin/user-hook");
    assert.equal(settings.hooks.PermissionRequest.length, 2);
    assert.match(
      settings.hooks.PermissionRequest[1].hooks[0].command,
      /permissions hook codex$/,
    );

    const beforeFiles = await readdir(dirname(path));
    const repeated = await installPermissionTarget("codex", { home, ...RUNTIME });
    assert.equal(repeated.changed, false);
    assert.deepEqual(await readdir(dirname(path)), beforeFiles);

    const removed = await uninstallPermissionTarget("codex", { home, ...RUNTIME });
    assert.equal(removed.removed, true);
    const after = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(after, original);
  });
});

test("OpenCode doctor does not claim installation when the current runtime contract is unavailable", async () => {
  await withHome(async (home) => {
    const runtime = openCodeRuntime();
    await installPermissionTarget("opencode", { home, ...runtime.options });
    const inspected = await inspectPermissionTarget("opencode", {
      home,
      ...runtime.options,
      probeOpenCodeRuntime: async () => ({ functional: false, state: "not-running" }),
    });
    assert.equal(inspected.installed, false);
    assert.equal(inspected.state, "stale");
    assert.equal(inspected.runtime.protocol.state, "not-running");
    await uninstallPermissionTarget("opencode", { home, ...runtime.options });
  });
});

test("Claude settings and OpenCode owned plugin install only in explicit temporary paths", async () => {
  await withHome(async (home) => {
    const runtime = openCodeRuntime();
    const claude = await installPermissionTarget("claude", { home, ...RUNTIME });
    assert.equal(claude.path, join(home, ".claude", "settings.json"));
    assert.equal((await inspectPermissionTarget("claude", { home, ...RUNTIME })).installed, true);

    const openCode = await installPermissionTarget("opencode", { home, ...runtime.options });
    assert.equal(
      openCode.path,
      join(home, ".config", "opencode", "plugin", "relo-permissions-v1.js"),
    );
    const plugin = await readFile(openCode.path, "utf8");
    assert.match(plugin, /^\/\/ Relo-OWNED permission adapter/);
    assert.match(plugin, /permission\.asked/);
    assert.match(plugin, /opencode-v1-event/);
    assert.equal(plugin.includes("detached: true"), false);
    assert.equal(plugin.includes(".unref()"), false);
    const syntaxFixture = join(home, "relo-opencode-plugin-check.mjs");
    await writeFile(syntaxFixture, plugin, { mode: 0o600 });
    await import(`${pathToFileURL(syntaxFixture).href}?check=${Date.now()}`);
    assert.match(await readFile(openCode.launchAgentPath, "utf8"), /permissions<\/string><string>daemon/);
    assert.equal((await inspectPermissionTarget("opencode", { home, ...runtime.options })).installed, true);

    assert.equal((await uninstallPermissionTarget("claude", { home, ...RUNTIME })).removed, true);
    assert.equal((await uninstallPermissionTarget("opencode", { home, ...runtime.options })).removed, true);
    assert.equal(runtime.commands.some((args) => args[0] === "bootstrap"), true);
  });
});

test("OpenCode setup refuses to overwrite an unmanaged plugin", async () => {
  await withHome(async (home) => {
    const path = permissionInternals.targetPath("opencode", home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "export const UserPlugin = async () => ({});\n", { mode: 0o600 });
    await assert.rejects(
      installPermissionTarget("opencode", { home, ...openCodeRuntime().options }),
      (error) => error.code === "HOOK_CONFIG_CONFLICT",
    );
    assert.equal(await readFile(path, "utf8"), "export const UserPlugin = async () => ({});\n");
  });
});

test("permission config writes reject compare-and-swap races without overwriting the newer file", async () => {
  await withHome(async (home) => {
    const path = permissionInternals.targetPath("codex", home);
    await writeJson(path, { description: "original" });
    let changed = false;
    await assert.rejects(
      installPermissionTarget("codex", {
        home,
        ...RUNTIME,
        beforeCommit: async () => {
          if (changed) return;
          changed = true;
          await writeJson(path, { description: "concurrent update" });
        },
      }),
      (error) => error.code === "CONFIGURATION_CHANGED",
    );
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      description: "concurrent update",
    });
  });
});

function hookOverrides({ finalInteraction, delivery = DELIVERY, waitId = INTERACTION_ID } = {}) {
  let request;
  let idempotencyKey;
  const client = {
    authStatus: async () => ({
      authenticated: true,
      credential: {
        scopes: ["notifications:send", "interactions:create", "interactions:read"],
      },
    }),
    createInteraction: async (body, key) => {
      request = body;
      idempotencyKey = key;
      return { interaction: { id: INTERACTION_ID, state: "pending" }, delivery };
    },
    waitForInteraction: async () => ({ interaction: { id: waitId, state: "approved" } }),
    getInteraction: async () => ({
      interaction: finalInteraction ?? structuredClone(EXACT_PHONE_APPROVAL),
    }),
  };
  return {
    request: () => request,
    idempotencyKey: () => idempotencyKey,
    overrides: {
      configPath: () => CONFIG.path,
      loadConfig: async () => CONFIG,
      clientFactory: () => client,
      generateIdempotencyKey: () => "hook-idempotency-123",
    },
  };
}

test("Codex hook sends only categorical metadata and allows one exact durable approval", async () => {
  const fixture = hookOverrides();
  const stdout = [];
  const exitCode = await run(
    ["permissions", "hook", "codex"],
    { stdout: (line) => stdout.push(line) },
    {
      ...fixture.overrides,
      readPermissionInput: async () => ({
        hook_event_name: "PermissionRequest",
        session_id: "session-official-123",
        turn_id: "turn-official-456",
        cwd: "/Users/example/Secret Project",
        tool_name: "Bash",
        idempotency_key: "hostilealphanumericsecret123456789",
        tool_input: {
          command: "rm private.txt",
          patch: "secret patch",
          token: "never-forward-this-token",
        },
      }),
    },
  );
  assert.equal(exitCode, EXIT.OK);
  assert.deepEqual(JSON.parse(stdout[0]), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  });
  const serialized = JSON.stringify(fixture.request());
  assert.match(serialized, /Codex requests shell permission in ws_[a-f0-9]{12} for 1 resource/);
  assert.match(fixture.idempotencyKey(), /^relo-hook:codex:[a-f0-9]{64}$/);
  for (const forbidden of ["Secret Project", "rm private", "secret patch", "never-forward", "hostilealphanumericsecret123456789"]) {
    assert.equal(serialized.includes(forbidden), false);
    assert.equal(fixture.idempotencyKey().includes(forbidden), false);
  }
});

test("separate Codex permission requests never replay one phone approval", async () => {
  const keys = [];
  const generated = ["first-request-nonce", "second-request-nonce"];
  const client = {
    authStatus: async () => ({
      authenticated: true,
      credential: {
        scopes: ["notifications:send", "interactions:create", "interactions:read"],
      },
    }),
    createInteraction: async (_body, key) => {
      keys.push(key);
      return { interaction: { id: INTERACTION_ID, state: "pending" }, delivery: DELIVERY };
    },
    waitForInteraction: async () => ({
      interaction: { id: INTERACTION_ID, state: "approved" },
    }),
    getInteraction: async () => ({
      interaction: {
        id: INTERACTION_ID,
        type: "approval",
        state: "approved",
        action: "approve",
        respondingDevice: { id: "dev_123456789012", name: "iPhone" },
        respondedAt: "2026-08-07T00:00:00.000Z",
      },
    }),
  };
  const input = {
    hook_event_name: "PermissionRequest",
    session_id: "same-session",
    turn_id: "same-turn",
    cwd: "/private/project",
    tool_name: "Bash",
    tool_input: { command: "never transmitted" },
  };
  for (const nonce of generated) {
    const stdout = [];
    await run(
      ["permissions", "hook", "codex"],
      { stdout: (line) => stdout.push(line) },
      {
        configPath: () => CONFIG.path,
        loadConfig: async () => CONFIG,
        clientFactory: () => client,
        generateIdempotencyKey: () => nonce,
        readPermissionInput: async () => structuredClone(input),
      },
    );
    assert.equal(JSON.parse(stdout[0]).hookSpecificOutput.decision.behavior, "allow");
  }
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.match(keys[0], /^relo-hook:codex:[a-f0-9]{64}$/);
  assert.match(keys[1], /^relo-hook:codex:[a-f0-9]{64}$/);
  assert.equal(keys.join("\n").includes("never transmitted"), false);
});

test("permission hooks deny every missing, mismatched, non-approval, and non-durable outcome", async () => {
  const canonicalCases = [
    ["canonical ID mismatch", { ...EXACT_PHONE_APPROVAL, id: "int_other" }],
    ["missing type", { ...EXACT_PHONE_APPROVAL, type: undefined }],
    ["non-approval type", { ...EXACT_PHONE_APPROVAL, type: "text" }],
    ["missing state", { ...EXACT_PHONE_APPROVAL, state: undefined }],
    ["non-approved state", { ...EXACT_PHONE_APPROVAL, state: "denied" }],
    ["missing action", { ...EXACT_PHONE_APPROVAL, action: undefined }],
    ["mismatched action", { ...EXACT_PHONE_APPROVAL, action: "deny" }],
    ["missing responding device", { ...EXACT_PHONE_APPROVAL, respondingDevice: undefined }],
    ["missing responding device ID", {
      ...EXACT_PHONE_APPROVAL,
      respondingDevice: { name: "iPhone" },
    }],
    ["empty responding device ID", {
      ...EXACT_PHONE_APPROVAL,
      respondingDevice: { id: "", name: "iPhone" },
    }],
    ["missing response timestamp", { ...EXACT_PHONE_APPROVAL, respondedAt: undefined }],
    ["empty response timestamp", { ...EXACT_PHONE_APPROVAL, respondedAt: "" }],
  ];
  const cases = [
    ["wait ID mismatch", hookOverrides({ waitId: "int_different" })],
    ...canonicalCases.map(([name, finalInteraction]) => [name, hookOverrides({ finalInteraction })]),
    ["zero durable delivery", hookOverrides({
      delivery: { eligibleDevices: 1, durableCommands: 0, apnsJobs: 1 },
    })],
  ];
  for (const [name, fixture] of cases) {
    const stdout = [];
    const exitCode = await run(
      ["permissions", "hook", "claude"],
      { stdout: (line) => stdout.push(line) },
      {
        ...fixture.overrides,
        readPermissionInput: async () => ({
          hook_event_name: "PermissionRequest",
          cwd: "/private/workspace",
          tool_name: "Write",
        }),
      },
    );
    assert.equal(exitCode, EXIT.OK);
    assert.equal(
      JSON.parse(stdout[0]).hookSpecificOutput.decision.behavior,
      "deny",
      name,
    );
  }

  const stdout = [];
  await run(
    ["permissions", "hook", "codex"],
    { stdout: (line) => stdout.push(line) },
    { readPermissionInput: async () => ({ hook_event_name: "wrong" }) },
  );
  assert.equal(JSON.parse(stdout[0]).hookSpecificOutput.decision.behavior, "deny");
});

test("OpenCode hook returns allow_once only for an exact approval", async () => {
  const fixture = hookOverrides();
  const stdout = [];
  await run(
    ["permissions", "hook", "opencode"],
    { stdout: (line) => stdout.push(line) },
    {
      ...fixture.overrides,
      readPermissionInput: async () => ({
        hook_event_name: "permission.ask",
        permission: "edit",
        workspace: "/private/project",
        resource_count: 4,
      }),
    },
  );
  assert.deepEqual(JSON.parse(stdout[0]), {
    agent: "opencode",
    decision: "allow_once",
    allowOnce: true,
  });
  assert.match(fixture.request().prompt, /OpenCode requests file-change permission/);
  assert.match(fixture.request().prompt, /for 4 resources/);
  assert.equal(fixture.request().prompt.includes("/private/project"), false);
});

test("restart-equivalent OpenCode hooks hash stable identity for server replay", async () => {
  const input = openCodeBridgeInternals.approvalInput(
    "edit", "/private/project", ["local secret resource"], "ses_restart", "per_restart", "c".repeat(64),
  );
  const keys = [];
  const interactions = new Map();
  let newInteractions = 0;
  const client = {
    authStatus: async () => ({
      authenticated: true,
      credential: { scopes: ["notifications:send", "interactions:create", "interactions:read"] },
    }),
    createInteraction: async (_body, key) => {
      keys.push(key);
      if (!interactions.has(key)) {
        newInteractions += 1;
        interactions.set(key, INTERACTION_ID);
      }
      return { interaction: { id: interactions.get(key), state: "pending" }, delivery: DELIVERY };
    },
    waitForInteraction: async () => ({ interaction: { id: INTERACTION_ID, state: "approved" } }),
    getInteraction: async () => ({ interaction: {
      id: INTERACTION_ID,
      type: "approval",
      state: "approved",
      action: "approve",
      respondingDevice: { id: "dev_123456789012", name: "iPhone" },
      respondedAt: "2026-08-07T00:00:00.000Z",
    } }),
  };
  for (const generated of ["first-process-random", "second-process-random"]) {
    const stdout = [];
    await run(["permissions", "hook", "opencode"], { stdout: (line) => stdout.push(line) }, {
      configPath: () => CONFIG.path,
      loadConfig: async () => CONFIG,
      clientFactory: () => client,
      generateIdempotencyKey: () => generated,
      readPermissionInput: async () => structuredClone(input),
    });
    assert.equal(JSON.parse(stdout[0]).allowOnce, true);
  }
  assert.equal(newInteractions, 1);
  assert.equal(keys[0], keys[1]);
  assert.match(keys[0], /^relo-hook:opencode:[a-f0-9]{64}$/);
  assert.notEqual(keys[0], input.idempotency_key);
  assert.equal(keys[0].includes(input.idempotency_key), false);
});
