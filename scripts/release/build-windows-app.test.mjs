import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARRIED, buildNumber, configOverride, inBatches, manifestFor, payloadBinaries, setupBuild, signtoolArguments } from "./build-windows-app.mjs";

test("the manifest carries what the server reads, and the signature only when there is one", () => {
  const base = { version: "0.1.0", sha256: "a".repeat(64), executable: "Relo.exe", notes: "", pubDate: "2026-10-24T10:00:00.000Z" };
  assert.deepEqual(manifestFor(base), { ...base, signed: false });
  const full = manifestFor({ ...base, signature: "c2ln", signed: "authenticode", zipSha256: "b".repeat(64), size: 5 });
  assert.equal(full.signature, "c2ln");
  assert.equal(full.signed, "authenticode");
  assert.equal(full.size, 5);
});

test("signtool is used only with a certificate, from a file or the store", () => {
  assert.equal(signtoolArguments("a.exe", {}), undefined);
  const file = signtoolArguments("a.exe", { RELO_WINDOWS_CERT_FILE: "c.pfx", RELO_WINDOWS_CERT_PASSWORD: "pw" });
  assert.deepEqual(file.slice(-5), ["/f", "c.pfx", "/p", "pw", "a.exe"]);
  assert.ok(file.includes("/fd") && file.includes("/tr") && file.includes("/td"));
  assert.deepEqual(signtoolArguments("a.exe", { RELO_WINDOWS_CERT_THUMBPRINT: "ABC" }).slice(-3), ["/sha1", "ABC", "a.exe"]);
  assert.ok(signtoolArguments("a.exe", { RELO_WINDOWS_CERT_FILE: "c.pfx", RELO_WINDOWS_TIMESTAMP_URL: "http://ts.example" }).includes("http://ts.example"));
});

test("the config override adds the payload as the server resource folder and the sidecar only when they exist", () => {
  assert.deepEqual(configOverride({}), { bundle: {} });
  assert.deepEqual(configOverride({ payload: "C:/p", launcher: "x.exe", version: "1.2.3" }), {
    version: "1.2.3", bundle: { resources: { "C:/p": "server" }, externalBin: ["binaries/ReloServer"] },
  });
});

test("the manifest carries the build number and the critical flag only when they are set", () => {
  const base = { version: "0.1.0", sha256: "a".repeat(64), executable: "Relo.exe", pubDate: "2026-10-24T10:00:00.000Z" };
  assert.equal("build" in manifestFor(base), false);
  assert.equal("critical" in manifestFor(base), false);
  const full = manifestFor({ ...base, build: 412, critical: true });
  assert.equal(full.build, 412);
  assert.equal(full.critical, true);
  assert.equal(manifestFor({ ...base, build: 0 }).build, 0);
});

test("the build number counts commits to what the app carries, as the Mac's does", () => {
  assert.ok(CARRIED.includes("apps/windows") && CARRIED.includes("apps/server") && CARRIED.includes("scripts/release") && CARRIED.includes("pnpm-lock.yaml"));
  const number = buildNumber();
  assert.ok(number === undefined || (Number.isInteger(number) && number >= 0));
});

test("every executable, library and native addon of the payload is found for Authenticode, nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "relo-payload-"));
  for (const file of ["node.exe", "app/postgres/bin/postgres.exe", "app/postgres/lib/libpq.DLL", "app/server/node_modules/x/addon.node", "VERSION", "cli/bin/relo.mjs", "app/dashboard/dist/app.js"]) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "x");
  }
  const found = payloadBinaries(dir).map((file) => file.slice(dir.length + 1).replaceAll("\\", "/"));
  assert.deepEqual(found, ["app/postgres/bin/postgres.exe", "app/postgres/lib/libpq.DLL", "app/server/node_modules/x/addon.node", "node.exe"]);
});

test("signtool takes many files in one command, in batches a command line can hold", () => {
  const args = signtoolArguments(["a.exe", "b.dll"], { RELO_WINDOWS_CERT_THUMBPRINT: "ABC" });
  assert.deepEqual(args.slice(-4), ["/sha1", "ABC", "a.exe", "b.dll"]);
  assert.deepEqual(inBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(inBatches([], 2), []);
});

test("Relo Setup is built around the NSIS installer, with the cargo job limit only when one is set", () => {
  const build = setupBuild({ payload: "C:/n/Relo_1.2.3_x64-setup.exe", version: "1.2.3", manifest: "apps/windows/setup/Cargo.toml", env: {} });
  assert.deepEqual(build.args, ["build", "--release", "--manifest-path", "apps/windows/setup/Cargo.toml"]);
  assert.deepEqual(build.env, { RELO_SETUP_PAYLOAD: "C:/n/Relo_1.2.3_x64-setup.exe", RELO_SETUP_VERSION: "1.2.3" });
  const limited = setupBuild({ payload: "p.exe", manifest: "m", env: { CARGO_BUILD_JOBS: "6" } });
  assert.deepEqual(limited.args.slice(0, 4), ["build", "--release", "-j", "6"]);
  assert.equal("RELO_SETUP_VERSION" in limited.env, false);
});
