import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { validateSkill } from "../scripts/validate-skill.mjs";
import {
  chooseActivityStyle,
  classifyExplicitTrigger,
  evaluateErrorFixture,
  runActivityWorkflow,
  runBrowserAuthWorkflow,
  runNotifierMaintenanceWorkflow,
  runOrdinarySendWorkflow,
  runPermissionWorkflow,
  runPinnedInstall,
  runServiceCreationWorkflow,
  runToolingLifecycle,
} from "./workflow-harness.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliRoot = resolve(packageRoot, "..", "cli");
const notifierRoot = resolve(packageRoot, "..", "codex-notify");
const packageSourceAvailable = existsSync(join(packageRoot, "SKILL.md"));
const cliSourceAvailable = existsSync(join(cliRoot, "src", "cli.mjs"));
const notifierSourceAvailable = existsSync(join(notifierRoot, "package.json"));
const cases = JSON.parse(readFileSync(join(packageRoot, "tests", "cases.json"), "utf8"));
const envelope = (data, exitCode = 0) => ({ exitCode, stdout: `${JSON.stringify({ ok: exitCode === 0, data })}\n` });

async function cliInvoker(client, dependencyOverrides = {}) {
  const { run: runRelo } = await import(pathToFileURL(join(cliRoot, "src", "cli.mjs")));
  return async (argv) => {
    const stdout = [];
    const stderr = [];
    const exitCode = await runRelo(
      argv,
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        configPath: () => "/local-only/config.json",
        loadConfig: async () => ({
          apiUrl: "https://relo.example.test",
          token: `klb_${"x".repeat(44)}`,
          principal: {
            id: "prn_skill",
            scopes: ["notifications:send", "interactions:create", "interactions:read"],
          },
        }),
        clientFactory: () => client,
        ...dependencyOverrides,
      },
    );
    return {
      exitCode,
      stdout: stdout.length === 0 ? "" : `${stdout.join("\n")}\n`,
      stderr: stderr.length === 0 ? "" : `${stderr.join("\n")}\n`,
    };
  };
}

test("explicit trigger and non-trigger fixtures execute as a table while model quality stays separate", () => {
  for (const item of cases.shouldTrigger) {
    assert.equal(classifyExplicitTrigger(item.prompt), true, item.name);
  }
  for (const item of cases.shouldNotTrigger) {
    assert.equal(classifyExplicitTrigger(item.prompt), false, item.name);
  }
  assert.equal(cases.modelTriggerQuality.status, "not-automated");
  assert.match(cases.modelTriggerQuality.reason, /separate model evaluation/i);
});

test("every error transcript executes a deterministic fail-closed disposition", () => {
  for (const item of cases.errorTranscripts) {
    assert.equal(evaluateErrorFixture(item.fixture), item.expectedAction, item.name);
  }
});

test("a copied installed bundle executes deterministic trigger, workflow, and error tables", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relo-installed-evals-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, ".agents", "skills", "relo-notifications");
  cpSync(packageRoot, installed, { recursive: true });
  const installedCases = JSON.parse(readFileSync(join(installed, "tests", "cases.json"), "utf8"));
  const harness = await import(`${pathToFileURL(join(installed, "tests", "workflow-harness.mjs")).href}?installed=1`);

  for (const item of installedCases.shouldTrigger) {
    assert.equal(harness.classifyExplicitTrigger(item.prompt), true, item.name);
  }
  for (const item of installedCases.shouldNotTrigger) {
    assert.equal(harness.classifyExplicitTrigger(item.prompt), false, item.name);
  }
  for (const item of installedCases.errorTranscripts) {
    assert.equal(harness.evaluateErrorFixture(item.fixture), item.expectedAction, item.name);
  }

  const executed = [];
  for (const item of installedCases.functional) {
    if (item.workflow === "ordinary-send") {
      const result = await harness.runOrdinarySendWorkflow(async (argv) => {
        assert.equal(argv.includes("--idempotency-key"), true);
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            ok: true,
            command: "notify.send",
            data: { delivery: { durableCommands: 1 } },
          })}\n`,
        };
      });
      assert.equal(result.accepted, true);
      executed.push(item.workflow);
    }
    if (item.workflow === "browser-auth") {
      const result = await harness.runBrowserAuthWorkflow(async (argv) => {
        assert.equal(argv.includes("--api-url"), true);
        assert.equal(argv.includes("--no-open"), true);
        return envelope({ authenticated: true, apiUrl: "https://relo.example.test" });
      });
      assert.deepEqual(result, { authenticated: true, credentialExposed: false });
      executed.push(item.workflow);
    }
    if (item.workflow === "notifier-maintenance") {
      const result = await harness.runNotifierMaintenanceWorkflow(async (command, args) => {
        assert.equal(JSON.stringify(args).includes("secret-token"), false);
        return command === "npm" && args[0] === "root"
          ? { exitCode: 0, stdout: "/prefix/lib/node_modules\n" }
          : { exitCode: 0, stdout: "" };
      }, {
        cliArtifact: "/artifacts/relo-cli-0.1.0.tgz",
        notifierArtifact: "/artifacts/relo-codex-notify-0.1.0.tgz",
        adapter: "/opt/relo-codex-notify",
        relo: "/opt/relo",
        config: "/config/codex.toml",
      });
      assert.equal(result.completed, true);
      executed.push(item.workflow);
    }
  }
  assert.deepEqual(executed.sort(), ["browser-auth", "notifier-maintenance", "ordinary-send"]);
});

test("ordinary-send and browser-auth functional cases execute through the real CLI", {
  skip: !cliSourceAvailable,
}, async () => {
  assert.equal(cases.functional.some((item) => item.workflow === "ordinary-send"), true);
  assert.equal(cases.functional.some((item) => item.workflow === "browser-auth"), true);

  const send = await runOrdinarySendWorkflow(await cliInvoker({
    sendNotification: async () => ({
      event: { id: "ntf_skill_send_123456" },
      delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 0 },
    }),
  }));
  assert.deepEqual(send, { accepted: true, command: "notify.send" });

  let now = 0;
  let saved;
  const scopes = ["interactions:create", "interactions:read", "notifications:send"];
  const auth = await runBrowserAuthWorkflow(await cliInvoker({
    startDeviceAuthorization: async ({ clientName, scopes: requestedScopes }) => {
      assert.equal(clientName, "Workstation agent");
      assert.deepEqual(requestedScopes, scopes);
      return {
        deviceCode: "d".repeat(43),
        userCode: "ABCD-EFGH",
        verificationUri: "https://relo.example.test/cli/authorize",
        verificationUriComplete: "https://relo.example.test/cli/authorize?code=ABCD-EFGH",
        expiresInSeconds: 600,
        intervalSeconds: 5,
      };
    },
    pollDeviceAuthorization: async () => ({
      accessToken: `relo_${"s".repeat(43)}`,
      credential: {
        id: "key_skill_auth_123456",
        clientName: "Workstation agent",
        prefix: "relo_ssss",
        scopes,
        createdAt: "2026-08-07T00:00:00.000Z",
        expiresAt: "2026-11-05T00:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      },
    }),
  }, {
    configRevision: async () => null,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    writeConfig: async (_path, value) => { saved = value; },
  }));
  assert.deepEqual(auth, { authenticated: true, credentialExposed: false });
  assert.equal(saved.apiUrl, "https://relo.example.test");
  assert.equal(saved.token.startsWith("relo_"), true);
});

test("notifier-maintenance functional case executes an explicit secret-free command table", async (t) => {
  assert.equal(cases.functional.some((item) => item.workflow === "notifier-maintenance"), true);
  const invoked = [];
  const result = await runNotifierMaintenanceWorkflow(async (command, args) => {
    invoked.push([command, args]);
    return command === "npm" && args[0] === "root"
      ? { exitCode: 0, stdout: "/prefix/lib/node_modules\n" }
      : { exitCode: 0, stdout: "" };
  }, {
    cliArtifact: "/artifacts/relo-cli-0.1.0.tgz",
    notifierArtifact: "/artifacts/relo-codex-notify-0.1.0.tgz",
    adapter: "/opt/relo-codex-notify",
    relo: "/opt/relo",
    config: "/config/codex.toml",
  });
  assert.equal(result.completed, true);
  assert.equal(invoked.length, 4);
  assert.equal(invoked[0][0], "npm");
  assert.deepEqual(invoked[1], ["npm", ["root", "--global"]]);
  assert.equal(invoked[2][1][0], "--dry-run");
  assert.equal(invoked[3][0], process.execPath);
  assert.equal(invoked[3][1][0], "/prefix/lib/node_modules/@relo/codex-notify/scripts/configure-codex-notify.mjs");
  assert.equal(invoked[3][1].includes("--config"), true);
  assert.equal(JSON.stringify(invoked).includes("token"), false);

  for (const stdout of ["relative/node_modules\n", "/one\n/two\n", ""]) {
    const refused = [];
    const invalid = await runNotifierMaintenanceWorkflow(async (command, args) => {
      refused.push([command, args]);
      return command === "npm" && args[0] === "root"
        ? { exitCode: 0, stdout }
        : { exitCode: 0, stdout: "" };
    }, {
      cliArtifact: "/artifacts/relo-cli-0.1.0.tgz",
      notifierArtifact: "/artifacts/relo-codex-notify-0.1.0.tgz",
      adapter: "/opt/relo-codex-notify",
      relo: "/opt/relo",
      config: "/config/codex.toml",
    });
    assert.equal(invalid.completed, false);
    assert.equal(refused.length, 2);
  }

  const root = mkdtempSync(join(tmpdir(), "relo-notifier-dry-run-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "config.toml");
  const sentinel = 'model = "unchanged"\n';
  writeFileSync(config, sentinel, { mode: 0o600 });
  const failedCalls = [];
  const failed = await runNotifierMaintenanceWorkflow(async (command, args) => {
    failedCalls.push([command, args]);
    if (command === "npm" && args[0] === "root") {
      return { exitCode: 0, stdout: "/prefix/lib/node_modules\n" };
    }
    if (command === "/opt/relo-codex-notify") {
      return { exitCode: 3, stdout: "", stderr: "dry-run failed" };
    }
    if (command === process.execPath) writeFileSync(config, "mutated\n");
    return { exitCode: 0, stdout: "" };
  }, {
    cliArtifact: "/artifacts/relo-cli-0.1.0.tgz",
    notifierArtifact: "/artifacts/relo-codex-notify-0.1.0.tgz",
    adapter: "/opt/relo-codex-notify",
    relo: "/opt/relo",
    config,
  });
  assert.equal(failed.completed, false);
  assert.equal(failed.failedAt, "adapter-dry-run");
  assert.deepEqual(failed.evidence, {
    installExitCode: 0,
    rootExitCode: 0,
    dryRunExitCode: 3,
    configureExitCode: undefined,
  });
  assert.equal(failedCalls.length, 3);
  assert.equal(failedCalls.some(([command]) => command === process.execPath), false);
  assert.equal(readFileSync(config, "utf8"), sentinel);
});

test("packed notifier maintenance resolves and executes the installed configuration helper", {
  timeout: 120_000,
  skip: !cliSourceAvailable || !notifierSourceAvailable,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relo-notifier-maintenance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installedSkill = join(root, ".agents", "skills", "relo-notifications");
  cpSync(packageRoot, installedSkill, { recursive: true });
  const installedHarness = await import(
    `${pathToFileURL(join(installedSkill, "tests", "workflow-harness.mjs")).href}?notifier=1`
  );
  const prefix = join(root, "prefix");
  const config = join(root, "config.toml");
  writeFileSync(config, 'model = "reviewed"\n', { mode: 0o600 });
  const env = {
    ...process.env,
    npm_config_cache: join(root, "npm-cache"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  const pack = (source) => {
    const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", root], {
      cwd: source,
      encoding: "utf8",
      timeout: 60_000,
      env,
    });
    assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
    return join(root, JSON.parse(packed.stdout)[0].filename);
  };
  const cliArtifact = pack(cliRoot);
  const notifierArtifact = pack(notifierRoot);
  const adapter = join(prefix, "bin", "relo-codex-notify");
  const relo = join(prefix, "bin", "relo");
  const calls = [];
  const runTool = (command, args) => {
    calls.push([command, args]);
    const executed = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 60_000,
      env,
    });
    return {
      exitCode: executed.status ?? 1,
      stdout: executed.stdout ?? "",
      stderr: executed.stderr ?? "",
    };
  };

  const result = await installedHarness.runNotifierMaintenanceWorkflow(runTool, {
    cliArtifact,
    notifierArtifact,
    adapter,
    relo,
    config,
    npmPrefix: prefix,
  });
  assert.equal(result.completed, true, JSON.stringify(calls));
  assert.equal(existsSync(result.configureScript), true);
  assert.equal(
    result.configureScript,
    join(prefix, "lib", "node_modules", "@relo", "codex-notify", "scripts", "configure-codex-notify.mjs"),
  );
  const configured = readFileSync(config, "utf8");
  assert.match(configured, /^model = "reviewed"\nnotify = \[/u);
  assert.equal(configured.includes(adapter), true);
  assert.equal(configured.includes(relo), true);
  assert.equal(existsSync(`${config}.before-relo-notify-skill-maintenance`), true);
});

test("mocked permission CLI workflow authorizes only exact canonical approval", async () => {
  const exactApproval = {
    id: "int_exact",
    type: "approval",
    state: "approved",
    action: "approve",
    respondingDevice: { id: "dev_exact", name: "iPhone" },
    respondedAt: "2026-08-07T00:00:00.000Z",
  };
  const scenario = async (canonical, create = {}) => {
    const calls = [];
    const result = await runPermissionWorkflow(async (argv) => {
      calls.push(argv);
      if (argv[0] === "notify") return envelope({
        interaction: { id: "int_exact", state: "approved" },
        delivery: { durableCommands: 1 },
        ...create,
      }, create.exitCode ?? 0);
      return envelope({ interaction: canonical });
    });
    return { result, calls };
  };
  assert.equal((await scenario(exactApproval)).result.allowed, true);
  for (const canonical of [
    { id: "int_exact", type: "yes_no", state: "yes" },
    { id: "int_exact", type: "text", state: "replied" },
    { ...exactApproval, id: "int_other" },
    { ...exactApproval, action: null },
    { ...exactApproval, respondingDevice: null },
    { ...exactApproval, respondedAt: null },
    { id: "int_exact", type: "approval", state: "pending" },
  ]) assert.equal((await scenario(canonical)).result.allowed, false);
  assert.equal((await scenario(exactApproval, { delivery: { durableCommands: 0 } })).result.allowed, false);

  const malformed = await runPermissionWorkflow(async (argv) => argv[0] === "notify"
    ? { exitCode: 0, stdout: '{"ok":true}\n{"ok":true}\n' }
    : envelope({ interaction: exactApproval }));
  assert.equal(malformed.allowed, false);
});

test("permission workflow runs through the real CLI and retains durable creation proof", {
  skip: !cliSourceAvailable,
}, async () => {
  let getCalls = 0;
  const result = await runPermissionWorkflow(await cliInvoker({
    createInteraction: async () => ({
      interaction: { id: "int_real_123456", state: "pending" },
      eventId: "ntf_real_123456",
      delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 0 },
      queued: 0,
      replayed: false,
    }),
    waitForInteraction: async () => ({
      interaction: { id: "int_real_123456", state: "approved", response: null },
    }),
    getInteraction: async () => {
      getCalls += 1;
      return {
        interaction: {
          id: "int_real_123456",
          type: "approval",
          state: "approved",
          action: "approve",
          respondingDevice: { id: "dev_real_123456", name: "iPhone" },
          respondedAt: "2026-08-07T00:00:00.000Z",
          response: null,
        },
      };
    },
  }));
  assert.deepEqual(result, {
    allowed: true,
    reason: "approved",
    interactionId: "int_real_123456",
  });
  assert.equal(getCalls, 1);
});

test("real CLI terminal outcomes retain safe proof while the permission workflow denies", {
  skip: !cliSourceAvailable,
}, async () => {
  for (const state of ["denied", "no", "canceled", "expired", "pending"]) {
    let now = 0;
    const creation = {
      interaction: { id: `int_${state}_123456`, state: "pending" },
      eventId: `ntf_${state}_123456`,
      liveActivityId: `act_${state}_123456`,
      delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 0 },
      queued: 0,
      replayed: false,
    };
    const invoke = await cliInvoker({
      createInteraction: async () => creation,
      waitForInteraction: async (_id, timeoutSeconds) => {
        now += timeoutSeconds * 1_000;
        return { interaction: { id: creation.interaction.id, state, response: null } };
      },
    }, {
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });
    const results = [];
    const outcome = await runPermissionWorkflow(async (argv) => {
      const result = await invoke(argv);
      results.push(result);
      return result;
    });
    assert.equal(outcome.allowed, false, state);
    assert.equal(outcome.reason, "create-gate", state);
    assert.equal(results.length, 1, state);
    const error = JSON.parse(results[0].stdout).error;
    assert.deepEqual(error.details.result, {
      ...creation,
      interaction: { id: creation.interaction.id, state, response: null },
    }, state);
    assert.notEqual(results[0].exitCode, 0, state);
  }
});

test("skill idempotency guidance matches the real CLI's accepted supplied-key range", {
  skip: !cliSourceAvailable,
}, async () => {
  const keys = [];
  const invoke = await cliInvoker({
    createInteraction: async (_body, key) => {
      keys.push(key);
      return {
        interaction: { id: "int_limit_123456", state: "pending" },
        delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 0 },
      };
    },
  });
  const acceptedMinimum = await invoke([
    "notify", "ask", "Continue?", "--approval", "--idempotency-key", "a", "--json",
  ]);
  const acceptedMaximum = await invoke([
    "notify", "ask", "Continue?", "--approval", "--idempotency-key", "a".repeat(200), "--json",
  ]);
  const rejected = await invoke([
    "notify", "ask", "Continue?", "--approval", "--idempotency-key", "a".repeat(201), "--json",
  ]);
  assert.equal(acceptedMinimum.exitCode, 0);
  assert.equal(acceptedMaximum.exitCode, 0);
  assert.equal(rejected.exitCode, 2);
  assert.deepEqual(keys, ["a", "a".repeat(200)]);
  assert.match(readFileSync(join(packageRoot, "references", "security.md"), "utf8"), /1–200 characters/);
});

test("mocked activity CLI workflow is handle-free and reserves the returned ID only for wait", async () => {
  let sequence = 0;
  let ends = 0;
  let waits = 0;
  const calls = [];
  const result = await runActivityWorkflow(async (argv) => {
    calls.push(argv);
    const activityId = "act_11111111-1111-4111-8111-111111111111";
    if (argv[1] === "ensure") return envelope({ activity: { id: activityId, sequence } });
    if (argv[1] === "wait") {
      waits += 1;
      assert.equal(argv[2], activityId);
      return envelope({
        parentActivityId: activityId,
        companionActivityId: "act_22222222-2222-4222-8222-222222222222",
        interaction: {
          id: "int_33333333-3333-4333-8333-333333333333",
          type: "approval",
          state: "approved",
          action: "approve",
          respondingDevice: { id: "dev_123456789012" },
          respondedAt: "2026-08-07T12:01:00.000Z",
        },
        delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 0 },
      });
    }
    assert.equal(argv.includes("--if-sequence"),false);
    assert.equal(argv.includes("--key"),false);
    assert.equal(argv.includes("--name"),false);
    sequence += 1;
    if (argv[1] === "end") ends += 1;
    return envelope({ activity: { id: activityId, sequence } });
  }, { style: "standard", milestones: ["Testing", "Packaging"] });
  assert.equal(result.completed, true);
  assert.equal(result.waited, true);
  assert.equal(result.interactionId, "int_33333333-3333-4333-8333-333333333333");
  assert.equal(waits, 1);
  assert.equal(ends, 1);
  assert.equal(calls.every((argv) => !argv.join(" ").includes("/private/") && !argv.join(" ").includes("raw command")), true);
  assert.equal(chooseActivityStyle({ longRunning: false }), undefined);
  assert.equal(chooseActivityStyle({ longRunning: true, quantitative: true }), "standard");
  assert.equal(chooseActivityStyle({ longRunning: true, stages: ["a", "b"] }), "steps");
  assert.equal(chooseActivityStyle({ longRunning: true, terminalLike: true }), "terminal");
  assert.equal(chooseActivityStyle({ longRunning: true, prominent: true }), "hero");
  assert.equal(chooseActivityStyle({ longRunning: true }), "standard");
});

test("captured service workflow requires secret-file and accepts only redacted metadata", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relo-skill-service-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secretFile = join(root, "service.url");
  const secret = "https://relo.example/hooks/hook_local_secret";
  let argv;
  const result = await runServiceCreationWorkflow(async (input) => {
    argv = input;
    assert.equal(input.includes("--secret-file"), true);
    writeFileSync(secretFile, secret, { mode: 0o600, flag: "wx" });
    return envelope({
      service: { id: "svc_exact", title: "Builds" },
      secretFileWritten: true,
      secretFileName: "service.url",
    });
  }, { title: "Builds", secretFile });
  assert.equal(result.created, true);
  assert.equal(readFileSync(secretFile, "utf8"), secret);
  assert.equal(argv.join(" ").includes(secret), false);
});

test("pinned installer workflow defaults to the reviewed package directory and validates the installed copy", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relo-pinned-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let seen;
  await runPinnedInstall(async (command, args) => {
    seen = { command, args };
    const installed = join(root, ".agents", "skills", "relo-notifications");
    cpSync(packageRoot, installed, { recursive: true });
    assert.deepEqual(validateSkill(installed).errors, []);
    return { installed };
  });
  assert.deepEqual(seen, {
    command: "npx",
    args: [
      "--yes", "skills@1.5.22", "add", "./skills/relo-notifications",
      "--skill", "relo-notifications", "--agent", "codex", "--yes", "--copy",
    ],
  });
  const installReference = readFileSync(join(packageRoot, "references", "install.md"), "utf8");
  assert.match(installReference, /Repository-root discovery .* is unsupported/u);
  assert.equal(installReference.includes("skills@1.5.22 add . --skill"), false);

  await runPinnedInstall(async (_command, args) => {
    assert.equal(args.includes("--global"), true);
  }, { global: true });
});

test("pinned skills installer creates and validates an actual disposable project copy", {
  timeout: 120_000,
  skip: !packageSourceAvailable,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relo-skills-cli-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(packageRoot, join(root, "skills", "relo-notifications"), { recursive: true });
  const result = await runPinnedInstall((command, args) => spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 90_000,
  }));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const installerOutput = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
  assert.match(installerOutput, /Found 1 skill/);
  assert.match(installerOutput, /Selected 1 skill: relo-notifications/);
  assert.match(installerOutput, /Installed 1 skill/);
  const installed = join(root, ".agents", "skills", "relo-notifications");
  assert.deepEqual(validateSkill(installed).errors, []);
  const validation = spawnSync(process.execPath, ["scripts/validate-skill.mjs"], {
    cwd: installed,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(validation.status, 0, `${validation.stdout}\n${validation.stderr}`);
  assert.equal(validation.stdout.includes("Relo skill validation passed"), true);
  const installedTests = spawnSync(process.execPath, ["--test"], {
    cwd: installed,
    encoding: "utf8",
    timeout: 90_000,
  });
  assert.equal(installedTests.status, 0, `${installedTests.stdout}\n${installedTests.stderr}`);
});

test("tooling lifecycle routes install, update, exact rollback, and uninstall to explicit artifacts", async () => {
  const calls = [];
  const artifacts = {
    identityHelper: "/reviewed/skills/relo-notifications/scripts/artifact-pair.mjs",
    oldManifest: "/artifacts/relo-tooling-pair-0.1.0.json",
    oldCli: "/artifacts/relo-cli-0.1.0.tgz",
    oldNotifier: "/artifacts/relo-codex-notify-0.1.0.tgz",
    newManifest: "/artifacts/relo-tooling-pair-0.5.0.json",
    newCli: "/artifacts/relo-cli-0.5.0.tgz",
    newNotifier: "/artifacts/relo-codex-notify-0.5.0.tgz",
  };
  await runToolingLifecycle(async (command, args) => calls.push([command, args]), artifacts);
  assert.equal(calls.length, 7);
  const verify = (manifest, cli, notifier) => [process.execPath, [
    artifacts.identityHelper, "verify", "--manifest", manifest,
    "--cli", cli, "--notifier", notifier,
  ]];
  assert.deepEqual(calls[0], verify(artifacts.oldManifest, artifacts.oldCli, artifacts.oldNotifier));
  assert.deepEqual(calls[1], ["npm", ["install", "--global", artifacts.oldCli, artifacts.oldNotifier]]);
  assert.deepEqual(calls[2], verify(artifacts.newManifest, artifacts.newCli, artifacts.newNotifier));
  assert.deepEqual(calls[3], ["npm", ["install", "--global", artifacts.newCli, artifacts.newNotifier]]);
  assert.deepEqual(calls[4], calls[0]);
  assert.deepEqual(calls[5], calls[1]);
  assert.deepEqual(calls[6], ["npm", [
    "uninstall", "--global", "@relo/codex-notify", "@relo/cli",
  ]]);
});

test("reviewed CLI packs, installs into a disposable prefix, and reports the coupled version", {
  timeout: 120_000,
  skip: !cliSourceAvailable,
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), "relo-reviewed-cli-pack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const env = {
    ...process.env,
    npm_config_cache: join(root, "npm-cache"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", root], {
    cwd: cliRoot,
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
  assert.equal(packed.error, undefined);
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
  const [artifact] = JSON.parse(packed.stdout);
  const prefix = join(root, "prefix");
  const installed = spawnSync("npm", [
    "install", "--global", "--ignore-scripts", "--prefix", prefix, join(root, artifact.filename),
  ], { encoding: "utf8", timeout: 60_000, env });
  assert.equal(installed.error, undefined);
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  const version = spawnSync(join(prefix, "bin", "relo"), ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
    env,
  });
  assert.equal(version.status, 0, `${version.stdout}\n${version.stderr}`);
  assert.equal(version.stdout.trim(), manifest.reviewedToolingVersions["@relo/cli"]);
});

test("skill directory performs actual backup, update, atomic restore, validation, and removal", (t) => {
  const root = mkdtempSync(join(tmpdir(), "relo-skill-lifecycle-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oldSource = join(root, "reviewed-old");
  const newSource = join(root, "reviewed-new");
  const installed = join(root, ".agents", "skills", "relo-notifications");
  const archive = join(root, ".local", "share", "relo", "skill-archives", "test-release");
  const backup = join(archive, "relo-notifications.rollback-0.1.0");
  const replaced = join(archive, "relo-notifications.failed-0.5.0");
  cpSync(packageRoot, oldSource, { recursive: true });
  cpSync(packageRoot, newSource, { recursive: true });
  writeFileSync(join(oldSource, ".fixture-version"), "0.1.0\n");
  writeFileSync(join(newSource, ".fixture-version"), "0.5.0\n");

  cpSync(oldSource, installed, { recursive: true });
  mkdirSync(archive, { recursive: true });
  assert.deepEqual(validateSkill(installed).errors, []);
  assert.equal(readFileSync(join(installed, ".fixture-version"), "utf8"), "0.1.0\n");

  renameSync(installed, backup);
  cpSync(newSource, installed, { recursive: true });
  assert.deepEqual(validateSkill(installed).errors, []);
  assert.equal(readFileSync(join(installed, ".fixture-version"), "utf8"), "0.5.0\n");

  renameSync(installed, replaced);
  renameSync(backup, installed);
  assert.deepEqual(validateSkill(installed).errors, []);
  assert.equal(readFileSync(join(installed, ".fixture-version"), "utf8"), "0.1.0\n");

  const removal = spawnSync("npx", [
    "--yes", "skills@1.5.22", "remove", "relo-notifications", "--yes",
  ], { cwd: root, encoding: "utf8", timeout: 90_000 });
  assert.equal(removal.status, 0, `${removal.stdout}\n${removal.stderr}`);
  assert.equal(existsSync(installed), false);
});
