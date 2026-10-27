import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertIntegrity, defaultReleaseIdentity, integrityOf, NODE_VERSION, PayloadError, payloadKey, postgresLicense, prunePostgres, shasumFor, writeReleaseIdentity,
} from "./windows-server-payload.mjs";

const HERE = resolve(fileURLToPath(import.meta.url), "..");

test("finds a file's digest in Node's SHASUMS256.txt, and refuses a missing or malformed one", () => {
  const digest = "a".repeat(64);
  const text = `${"b".repeat(64)}  node-v22.0.0-linux-x64.tar.gz\r\n${digest}  node-v22.0.0-win-x64.zip\r\n`;
  assert.equal(shasumFor(text, "node-v22.0.0-win-x64.zip"), digest);
  assert.throws(() => shasumFor(text, "node-v22.0.0-win-arm64.zip"), PayloadError);
  assert.throws(() => shasumFor("nothex  node-v22.0.0-win-x64.zip", "node-v22.0.0-win-x64.zip"), PayloadError);
});

test("checks PostgreSQL's registry integrity", () => {
  const bytes = Buffer.from("package");
  assertIntegrity(bytes, integrityOf(bytes));
  assert.throws(() => assertIntegrity(Buffer.from("tampered"), integrityOf(bytes)), /did not match its integrity/u);
});

test("keys the cache by the built tree, ignoring tests, and by the pinned Node", () => {
  const tree = "100644 blob aaa\tapps/server/src/app.ts\n100644 blob bbb\tapps/server/src/app.test.ts\n";
  const key = payloadKey(tree);
  assert.match(key, new RegExp(`^[0-9a-f]{16}-node${NODE_VERSION.replaceAll(".", "\\.")}-pg17\\.10-win-x64$`, "u"));
  assert.equal(payloadKey(tree.replace("bbb", "ccc")), key, "a test change keeps the cached payload");
  assert.notEqual(payloadKey(tree.replace("aaa", "ddd")), key, "a source change builds again");
  assert.notEqual(payloadKey(tree, "22.99.0"), key);
});

test("prunes the pgAdmin/wx leftovers, import libraries and message catalogs, and keeps what the server runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relo-pg-prune-"));
  for (const sub of ["bin", "lib", "share/locale/de", "share/timezone"]) await mkdir(join(dir, sub), { recursive: true });
  const files = {
    bin: ["postgres.exe", "pg_ctl.exe", "initdb.exe", "libpq.dll", "wxbase3210u_vc_x64_custom.dll", "wxmsw3210u_core_vc_x64_custom.dll", "testplug.dll"],
    lib: ["plpgsql.dll", "libssl.lib", "iconv.lib"],
  };
  for (const [sub, names] of Object.entries(files)) for (const name of names) await writeFile(join(dir, sub, name), "x");
  await writeFile(join(dir, "pg-symlinks.json"), "[]");
  await writeFile(join(dir, "share", "locale", "de", "x.mo"), "x");
  await writeFile(join(dir, "share", "postgres.bki"), "x");

  await prunePostgres(dir);
  assert.deepEqual((await readdir(join(dir, "bin"))).sort(), ["initdb.exe", "libpq.dll", "pg_ctl.exe", "postgres.exe"]);
  assert.deepEqual(await readdir(join(dir, "lib")), ["plpgsql.dll"]);
  assert.deepEqual((await readdir(join(dir, "share"))).sort(), ["postgres.bki", "timezone"]);
  assert.ok(!(await readdir(dir)).includes("pg-symlinks.json"));
});

test("takes the PostgreSQL licence from the Mac payload script", async () => {
  const license = postgresLicense(await readFile(join(HERE, "mac-server-payload.sh"), "utf8"));
  assert.match(license, /^PostgreSQL Database Management System/u);
  assert.match(license, /BASIS, AND THE UNIVERSITY OF CALIFORNIA HAS NO OBLIGATIONS/u);
  assert.throws(() => postgresLicense("nothing"), PayloadError);
});

test("the payload carries one release identity: the app version, one LF line", async () => {
  const conf = JSON.parse(await readFile(join(HERE, "..", "..", "apps", "windows", "src-tauri", "tauri.conf.json"), "utf8"));
  assert.equal(defaultReleaseIdentity(), conf.version);
  const dir = await mkdtemp(join(tmpdir(), "relo-identity-"));
  writeReleaseIdentity(dir, "1.2.3+45");
  assert.equal(await readFile(join(dir, "release-identity.txt"), "utf8"), "1.2.3+45\n");
  assert.throws(() => writeReleaseIdentity(dir, "not a version"), PayloadError);
  assert.throws(() => writeReleaseIdentity(dir, undefined), PayloadError);
});
