import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT } from "../src/shared/errors.mjs";
import { compactData } from "../src/shared/output.mjs";
import { execute, run, overrides } from "./cli-fixtures.mjs";

test("creates and lists services with canonical request fields", async () => {
  let created;
  const listed = {
    services: [
      {
        id: "svc_123456789012",
        title: "Builds",
        imageUrl: "https://example.test/bot.png",
        destinationUrl: "https://example.test/builds",
        prefix: "hook_example",
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z",
      },
    ],
  };
  const client = {
    createService: async (body) => {
      created = body;
      return { service: listed.services[0], endpoint: "https://server.example.test/hooks", secret: "hook_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr" };
    },
    listServices: async () => listed,
  };
  const createdOutput = await execute(["services", "create", "--title", "Builds", "--stdin"], {
    ...overrides(client),
    readStdinJson: async () => ({
      title: "stdin title",
      imageUrl: "https://example.test/bot.png",
      url: "https://example.test/builds",
    }),
  });
  const listedOutput = await execute(["services", "list"], overrides(client));
  assert.deepEqual(created, {
    title: "Builds",
    imageUrl: "https://example.test/bot.png",
    destinationUrl: "https://example.test/builds",
  });
  assert.equal(createdOutput.data.service.id, "svc_123456789012");
  assert.equal(createdOutput.data.endpoint, "https://server.example.test/hooks");
  assert.equal(createdOutput.data.secret, "hook_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr");
  assert.deepEqual(listedOutput.data, listed);
  assert.deepEqual(compactData("services.list", listed), { services: [{
    id: "svc_123456789012", title: "Builds", prefix: "hook_example", createdAt: "2026-08-07T00:00:00.000Z",
  }] });
});

test("service secret-file output is exclusive, private, durable, and secret-free", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-service-secret-"));
  const secretPath = join(directory, "builds.webhook");
  const secret = "hook_sssssssssssssssssssssssssssssssssssssssssss";
  const created = {
    service: { id: "svc_123456789012", title: "Builds", prefix: "hook_super" },
    endpoint: "https://server.example.test/hooks",
    secret,
  };
  try {
    const stdout = [];
    const stderr = [];
    const exitCode = await run(
      ["services", "create", "--title", "Builds", "--secret-file", secretPath, "--json"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      overrides({ createService: async () => created }),
    );
    assert.equal(exitCode, EXIT.OK);
    assert.equal(await readFile(secretPath, "utf8"), `${secret}\n`);
    if (process.platform !== "win32") assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
    assert.equal(stdout.join("\n").includes(secret), false);
    assert.equal(stderr.join("\n").includes(secret), false);
    assert.deepEqual(JSON.parse(stdout[0]), {
      ok: true,
      id: "svc_123456789012",
      title: "Builds",
      prefix: "hook_super",
      endpoint: "https://server.example.test/hooks",
      secretFileWritten: true,
      secretFileName: "builds.webhook",
    });
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("service secret-file refuses existing regular, symlink, and non-regular targets before creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-service-refuse-"));
  let creates = 0;
  const client = {
    createService: async () => {
      creates += 1;
      return { service: { id: "svc_never" }, endpoint: "https://server.example.test/hooks", secret: "hook_nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn" };
    },
  };
  try {
    const regular = join(directory, "existing");
    const linked = join(directory, "linked");
    const folder = join(directory, "folder");
    await writeFile(regular, "sentinel", { mode: 0o600 });
    await symlink(regular, linked);
    await mkdir(folder);
    for (const path of [regular, linked, folder]) {
      await assert.rejects(
        execute(["services", "create", "--title", "No", "--secret-file", path], overrides(client)),
        /Refusing to overwrite/,
      );
    }
    assert.equal(creates, 0);
    assert.equal(await readFile(regular, "utf8"), "sentinel");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("racing service secret-file writers publish once and clean temporary files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-service-race-"));
  const path = join(directory, "service.url");
  let creates = 0;
  const client = {
    createService: async () => {
      creates += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return {
        service: { id: "svc_race" },
        endpoint: "https://server.example.test/hooks", secret: "hook_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      };
    },
  };
  try {
    const results = await Promise.allSettled([
      execute(["services", "create", "--title", "Race", "--secret-file", path], overrides(client)),
      execute(["services", "create", "--title", "Race", "--secret-file", path], overrides(client)),
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.filter((item) => item.status === "rejected").length, 1);
    assert.equal(creates, 1);
    assert.equal(await readFile(path, "utf8"), "hook_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp") || name.endsWith(".lock")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("destination reservation blocks a noncooperating external creator during the API call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-service-external-race-"));
  const path = join(directory, "service.url");
  const secret = "hook_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  let externalError;
  try {
    const output = await execute(
      ["services", "create", "--title", "External race", "--secret-file", path],
      overrides({
        createService: async () => {
          try {
            await writeFile(path, "external", { flag: "wx", mode: 0o600 });
          } catch (error) {
            externalError = error;
          }
          return { service: { id: "svc_external" }, endpoint: "https://server.example.test/hooks", secret };
        },
      }),
    );
    assert.equal(externalError?.code, "EEXIST");
    assert.equal(await readFile(path, "utf8"), `${secret}\n`);
    assert.equal(output.data.secretFileWritten, true);
    assert.equal(JSON.stringify(output).includes(secret), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a renamed-away reservation is refused, revoked, and never overwrites its replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-service-replaced-reservation-"));
  const path = join(directory, "service.url");
  const movedPath = join(directory, "renamed-reservation.url");
  let revoked;
  try {
    await assert.rejects(
      execute(
        ["services", "create", "--title", "Replaced", "--secret-file", path],
        overrides({
          createService: async () => {
            await rename(path, movedPath);
            await writeFile(path, "external sentinel", { flag: "wx", mode: 0o600 });
            return {
              service: { id: "svc_replaced" },
              endpoint: "https://server.example.test/hooks", secret: "hook_mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm",
            };
          },
          revokeService: async (id) => { revoked = id; },
        }),
      ),
      /changed --secret-file reservation/,
    );
    assert.equal(revoked, "svc_replaced");
    assert.equal(await readFile(path, "utf8"), "external sentinel");
    assert.equal(await readFile(movedPath, "utf8"), "");
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("service secret-file failures do not expose the secret or leave partial files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-service-failure-"));
  const path = join(directory, "service.url");
  const secret = "hostilealphanumericsecret123456789";
  let revoked;
  try {
    const stdout = [];
    const stderr = [];
    const exitCode = await run(
      ["services", "create", "--title", "Broken", "--secret-file", path, "--json"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      overrides({
        createService: async () => ({ service: { id: "svc_bad" }, endpoint: "https://server.example.test/hooks", secret }),
        revokeService: async (id) => { revoked = id; },
      }),
    );
    assert.equal(exitCode, EXIT.API);
    assert.equal(stdout.join("\n").includes(secret), false);
    assert.equal(stderr.join("\n").includes(secret), false);
    assert.equal(revoked, "svc_bad");
    assert.equal(await readFile(path, "utf8"), "");
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp") || name.endsWith(".lock")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rotates a service to a new secret, printed or written to --secret-file", async () => {
  const secret = "hook_ttttttttttttttttttttttttttttttttttttttttttt";
  const rotated = [];
  const client = {
    rotateService: async (id) => {
      rotated.push(id);
      return { service: { id, title: "Builds", prefix: secret.slice(0, 13) }, endpoint: "https://server.example.test/hooks", secret };
    },
  };
  const printed = await execute(["services", "rotate", "svc_123456789012"], overrides(client));
  assert.equal(printed.data.secret, secret);
  assert.deepEqual(compactData("services.rotate", printed.data), {
    id: "svc_123456789012", title: "Builds", prefix: secret.slice(0, 13), endpoint: "https://server.example.test/hooks", secret,
  });

  const directory = await mkdtemp(join(tmpdir(), "relo-service-rotate-"));
  const secretPath = join(directory, "builds.secret");
  const filed = await execute(["services", "rotate", "svc_123456789012", "--secret-file", secretPath], overrides(client));
  assert.equal(filed.data.secret, undefined);
  assert.equal(filed.data.secretFileWritten, true);
  assert.equal(await readFile(secretPath, "utf8"), `${secret}\n`);
  if (process.platform !== "win32") assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
  assert.deepEqual(rotated, ["svc_123456789012", "svc_123456789012"]);
  await rm(directory, { recursive: true, force: true });
});

test("revokes a service by id and refuses anything that is not a service id", async () => {
  const revoked = [];
  const client = { revokeService: async (id) => { revoked.push(id); return { ok: true }; } };
  const output = await execute(["services", "revoke", "svc_123456789012"], overrides(client));
  assert.deepEqual(compactData("services.revoke", output.data), { id: "svc_123456789012", revoked: true });
  const stderr = [];
  const refused = await run(["services", "revoke", "hook_secret"], { stdout: () => {}, stderr: (line) => stderr.push(line) }, overrides(client));
  assert.equal(refused, EXIT.USAGE);
  assert.match(stderr.join("\n"), /relo services revoke svc_/u);
  assert.deepEqual(revoked, ["svc_123456789012"]);
});

test("services create and edit take the service's scopes and readable setting; unknown scopes are refused", async () => {
  const sent = [];
  const client = {
    createService: async (body) => { sent.push(["create", body]); return { service: { id: "svc_123456789012", title: "Shop" }, endpoint: "https://server.example.test/hooks", secret: "hook_ttttttttttttttttttttttttttttttttttttttttttt" }; },
    updateService: async (id, body) => { sent.push(["edit", id, body]); return { service: { id, title: "Shop", scopes: body.scopes, readableAllowed: body.readableAllowed } }; },
  };
  await execute(["services", "create", "--title", "Shop", "--scope", "hooks:notify", "--scope", "hooks:read", "--readable", "on"], overrides(client));
  const edited = await execute(["services", "edit", "svc_123456789012", "--scope", "hooks:works", "--readable", "off"], overrides(client));
  assert.deepEqual(sent, [
    ["create", { title: "Shop", scopes: ["hooks:notify", "hooks:read"], readableAllowed: true }],
    ["edit", "svc_123456789012", { scopes: ["hooks:works"], readableAllowed: false }],
  ]);
  assert.deepEqual(compactData("services.edit", edited.data), { id: "svc_123456789012", title: "Shop", scopes: ["hooks:works"], readableAllowed: false });
  const stderr = [];
  const refused = await run(["services", "edit", "svc_123456789012", "--scope", "services:write"], { stdout: () => {}, stderr: (line) => stderr.push(line) }, overrides(client));
  assert.equal(refused, EXIT.USAGE);
  assert.match(stderr.join("\n"), /Unknown service scope: services:write/u);
});
