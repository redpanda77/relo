import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configPath,
  configRevision,
  loadConfig,
  normalizeApiUrl,
  publicConfig,
  removeConfig,
  writeConfig,
} from "../src/config.mjs";

const TOKEN = `klb_${"s".repeat(44)}`;

test("resolves platform-specific config paths", () => {
  assert.equal(
    configPath({ env: {}, platform: "darwin", home: "/Users/test" }),
    "/Users/test/Library/Application Support/relo/config.json",
  );
  assert.equal(
    configPath({ env: { XDG_CONFIG_HOME: "/config" }, platform: "linux", home: "/home/test" }),
    "/config/relo/config.json",
  );
  assert.equal(
    configPath({ env: { RELO_CONFIG_PATH: "/explicit/config.json" }, platform: "linux" }),
    "/explicit/config.json",
  );
});

test("writes config atomically with private permissions and never exposes its token publicly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-config-"));
  const path = join(directory, "nested", "config.json");
  try {
    await writeConfig(path, {
      apiUrl: "https://server.example.test/",
      token: TOKEN,
      principal: { id: "prn_mac", scopes: ["notifications:send"] },
    });
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(directory, "nested"))).mode & 0o777, 0o700);
    }
    const loaded = await loadConfig(path);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.apiUrl, "https://server.example.test");
    assert.equal(loaded.token, TOKEN);
    assert.equal(loaded.revision, await configRevision(path));
    const safe = publicConfig(loaded);
    assert.equal("token" in safe, false);
    assert.equal(JSON.stringify(safe).includes(TOKEN), false);
    const stored = JSON.parse(await readFile(path, "utf8"));
    assert.equal(stored.version, 1);
    assert.equal(stored.token, TOKEN);
    assert.equal(await removeConfig(path), true);
    assert.equal(await removeConfig(path), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential write and removal reject compare-and-swap races", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-config-race-"));
  const path = join(directory, "config.json");
  const original = { apiUrl: "https://example.test", token: TOKEN };
  const concurrent = { apiUrl: "https://example.test", token: `klb_${"n".repeat(44)}` };
  try {
    await writeConfig(path, original);
    const revision = await configRevision(path);
    await assert.rejects(
      writeConfig(path, { ...original, token: `klb_${"r".repeat(44)}` }, {
        expectedRevision: revision,
        beforeCommit: async () => writeConfig(path, concurrent),
      }),
      (error) => error.code === "CONFIGURATION_CHANGED",
    );
    assert.equal((await loadConfig(path)).token, concurrent.token);
    await assert.rejects(
      removeConfig(path, { expectedRevision: revision }),
      (error) => error.code === "CONFIGURATION_CHANGED",
    );
    assert.equal((await loadConfig(path)).token, concurrent.token);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses group-readable and symlinked configs", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "relo-insecure-"));
  const target = join(directory, "target.json");
  const link = join(directory, "config.json");
  try {
    await writeFile(target, JSON.stringify({ apiUrl: "https://example.test", token: TOKEN }), { mode: 0o644 });
    await assert.rejects(loadConfig(target), /expected mode 0600/);
    await chmod(target, 0o600);
    await symlink(target, link);
    await assert.rejects(loadConfig(link), /non-regular config/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts private local HTTP but rejects public plaintext origins and invalid credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-invalid-"));
  const path = join(directory, "config.json");
  try {
    await writeFile(path, JSON.stringify({ apiUrl: "http://192.168.1.10:8180", token: TOKEN }), { mode: 0o600 });
    assert.equal((await loadConfig(path)).apiUrl, "http://192.168.1.10:8180");
    await writeFile(path, JSON.stringify({ apiUrl: "http://example.com", token: TOKEN }), { mode: 0o600 });
    await assert.rejects(loadConfig(path), /HTTPS or private local HTTP/);
    await writeFile(path, JSON.stringify({ apiUrl: "https://server.test", token: "short" }), { mode: 0o600 });
    await assert.rejects(loadConfig(path), /no valid credential/);
    assert.equal(normalizeApiUrl("http://192.168.1.10:8180/"), "http://192.168.1.10:8180");
    assert.throws(() => normalizeApiUrl("https://example.test/api"), /must be an origin/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
