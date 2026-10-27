#!/usr/bin/env node
// Builds Relo for Windows (apps/windows) into the folder a Relo server hands out as its `windows/` artifacts
// (apps/server/windows/README.md): the way scripts/release/build-mac-app.sh builds Relo for Mac.
//
//   node scripts/release/build-windows-app.mjs [--out DIR] [--version X.Y.Z] [--notes TEXT] [--critical] [--no-server] [--no-bootstrapper] [--allow-unsigned]
//
// What it does, in order:
//   1. the local-mode payload (Node, the server, the Dashboard, PostgreSQL, the CLI) from scripts/release/windows-server-payload.mjs,
//      or the folder RELO_WINDOWS_SERVER_PAYLOAD names; it becomes the installer's `server\` resource folder;
//   2. the ReloServer.exe sidecar from apps/windows/server-launcher (cargo), or the file RELO_WINDOWS_SERVER_LAUNCHER names;
//   3. the Tauri NSIS installer (per user, relo:// registered, Start menu shortcut), the Dashboard-free front end included;
//   4. Authenticode signing with signtool when a certificate is supplied: first every executable the payload carries
//      (node.exe, ReloServer.exe, PostgreSQL's .exe and .dll files, native .node addons: the Mac signs every Mach-O),
//      then the NSIS installer (otherwise a warning: Windows SmartScreen then warns people who run it);
//   4b. Relo Setup (apps/windows/setup): the small program people download. It embeds the signed NSIS installer, shows
//      Relo's own window, runs the installer silently and opens Relo; it is signed the same way. The NSIS installer
//      itself is what the Tauri updater runs, so it stays the update payload;
//   5. relo-windows-setup.exe (Relo Setup; the plain NSIS installer with --no-bootstrapper), relo-windows.zip (the NSIS
//      installer zipped: the update payload) and its minisign signature from TAURI_SIGNING_PRIVATE_KEY;
//   6. manifest.json (version, build, sha256 (of the download), executable, signature, notes, pubDate, critical), which the server reads.
//      `build` counts every commit to what the app carries (CARRIED), the way build-mac-app.sh numbers its builds.
// Without the payload or the launcher the app is built remote-only and says so. Without a certificate or an updater key it
// builds an unsigned installer and no update feed: fine for trying it, not for handing out.
//
// Environment (all optional):
//   RELO_WINDOWS_SERVER_PAYLOAD     a folder holding the payload (default: made by windows-server-payload.mjs when it exists)
//   RELO_WINDOWS_SERVER_LAUNCHER    a built ReloServer.exe (default: built from apps/windows/server-launcher when it exists)
//   RELO_WINDOWS_CERT_FILE          a .pfx for Authenticode; RELO_WINDOWS_CERT_PASSWORD its password
//   RELO_WINDOWS_CERT_THUMBPRINT    instead of a file: a certificate in the user's store
//   RELO_WINDOWS_ORIGIN             the server address the app suggests on its first screen (VITE_RELO_ORIGIN, build time)
//   RELO_WINDOWS_TIMESTAMP_URL      an RFC 3161 timestamp server (default: DigiCert's)
//   TAURI_SIGNING_PRIVATE_KEY       the updater's minisign key (the text, or a path to the file); TAURI_SIGNING_PRIVATE_KEY_PASSWORD
//   RELO_WINDOWS_WEBVIEW2           embedBootstrapper (default) | downloadBootstrapper
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const appDir = join(root, "apps", "windows");
const tauriDir = join(appDir, "src-tauri");
const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");

/** The Tauri CLI's entry, run with this Node (a .cmd shim cannot be spawned without a shell). */
const tauriCli = () => createRequire(join(appDir, "package.json")).resolve("@tauri-apps/cli/tauri.js");

/** Everything the app carries: one list makes the build number, so a change to anything inside is a newer build. */
export const CARRIED = [
  "apps/windows", "apps/server", "apps/dashboard", "packages/contracts", "packages/owner-crypto", "packages/owner-client",
  "packages/cli", "skills/relo-notifications", "scripts/release", "pnpm-lock.yaml",
];

/** The number of commits to what the app carries (build-mac-app.sh's BUILD); undefined outside a git checkout. */
export function buildNumber(cwd = root) {
  const result = spawnSync("git", ["rev-list", "--count", "HEAD", "--", ...CARRIED], { cwd, encoding: "utf8" });
  const count = Number.parseInt(result.stdout ?? "", 10);
  return result.status === 0 && Number.isInteger(count) ? count : undefined;
}

export const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** manifest.json as the server reads it (apps/server/src/computer-invites.ts, readWindowsApp). */
export function manifestFor({ version, build, sha256, executable, signature, notes = "", pubDate, signed, zipSha256, size, critical }) {
  return {
    version, ...(build !== undefined ? { build } : {}), sha256, executable,
    ...(signature ? { signature } : {}),
    notes, pubDate,
    signed: signed ?? false,
    ...(zipSha256 ? { zipSha256 } : {}),
    ...(size ? { size } : {}),
    ...(critical ? { critical: true } : {}),
  };
}

/** The files of a payload (or the sidecar folder) Authenticode applies to: programs, libraries and native addons. */
export function payloadBinaries(directory) {
  const found = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(exe|dll|node)$/iu.test(entry.name)) found.push(path);
    }
  };
  walk(directory);
  return found.sort();
}

/** Files in groups small enough for one signtool command line. */
export function inBatches(files, size = 40) {
  const batches = [];
  for (let i = 0; i < files.length; i += size) batches.push(files.slice(i, i + size));
  return batches;
}

/** The signtool command line for an installer, from the environment; undefined without a certificate. */
export function signtoolArguments(file, env = process.env) {
  const files = Array.isArray(file) ? file : [file];
  const stamp = env.RELO_WINDOWS_TIMESTAMP_URL || "http://timestamp.digicert.com";
  const common = ["sign", "/fd", "sha256", "/tr", stamp, "/td", "sha256", "/d", "Relo for Windows"];
  if (env.RELO_WINDOWS_CERT_FILE) {
    return [...common, "/f", env.RELO_WINDOWS_CERT_FILE, ...(env.RELO_WINDOWS_CERT_PASSWORD ? ["/p", env.RELO_WINDOWS_CERT_PASSWORD] : []), ...files];
  }
  if (env.RELO_WINDOWS_CERT_THUMBPRINT) return [...common, "/sha1", env.RELO_WINDOWS_CERT_THUMBPRINT, ...files];
  return undefined;
}

/** The Tauri config merged over tauri.conf.json for this build: the payload and sidecar the build found. */
export function configOverride({ payload, launcher, version, webview }) {
  return {
    ...(version ? { version } : {}),
    bundle: {
      ...(payload ? { resources: { [payload]: "server" } } : {}),
      ...(launcher ? { externalBin: ["binaries/ReloServer"] } : {}),
      ...(webview ? { windows: { webviewInstallMode: { type: webview, silent: true } } } : {}),
    },
  };
}

/** The cargo command and environment that build Relo Setup around the NSIS installer at `payload` (apps/windows/setup). */
export function setupBuild({ payload, version, manifest, env = process.env }) {
  return {
    args: ["build", "--release", ...(env.CARGO_BUILD_JOBS ? ["-j", env.CARGO_BUILD_JOBS] : []), "--manifest-path", manifest],
    env: { RELO_SETUP_PAYLOAD: payload, ...(version ? { RELO_SETUP_VERSION: version } : {}) },
  };
}

function parseArguments(argv) {
  const options = { out: join(root, "build", "windows-app", "windows"), server: true, bootstrapper: true, unsigned: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") options.out = resolve(argv[++i]);
    else if (arg === "--version") options.version = argv[++i];
    else if (arg === "--notes") options.notes = argv[++i];
    else if (arg === "--critical") options.critical = true;
    else if (arg === "--no-server") options.server = false;
    else if (arg === "--no-bootstrapper") options.bootstrapper = false;
    else if (arg === "--allow-unsigned") options.unsigned = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

const say = (text) => console.log(`windows-app: ${text}`);
const warn = (text) => console.warn(`windows-app: WARNING: ${text}`);

function run(file, args, { cwd = root, env = process.env, quiet = false } = {}) {
  const result = spawnSync(file, args, { cwd, env, stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} ${args.slice(0, 3).join(" ")} failed (exit ${result.status})${quiet ? `\n${result.stdout}${result.stderr}` : ""}`);
  return result;
}

/** PATH with cargo's folder, which rustup installs outside the usual PATH of a non-interactive shell. */
function buildEnvironment() {
  const origin = process.env.RELO_WINDOWS_ORIGIN?.trim();
  if (origin && !/^https?:\/\/[^\s/]+(?::\d+)?$/u.test(origin)) throw new Error(`RELO_WINDOWS_ORIGIN ${origin} must look like https://relo.example (no path)`);
  const cargoBin = join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "bin");
  const path = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  // The front end's build calls `pnpm` (prebuild of apps/windows). A global pnpm may fail to switch to the pinned
  // version, so a shim that runs the pinned one comes first.
  const shims = mkdtempSync(join(tmpdir(), "relo-pnpm-shim-"));
  writeFileSync(join(shims, "pnpm.cmd"), "@echo off\r\nnpx --yes pnpm@11.20.0 %*\r\n");
  return { ...process.env, ...(origin ? { VITE_RELO_ORIGIN: origin } : {}), [path]: `${shims}${delimiter}${process.env[path] ?? ""}${delimiter}${cargoBin}` };
}

function findSigntool() {
  const kits = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  if (!existsSync(kits)) return undefined;
  for (const version of readdirSync(kits).sort().reverse()) {
    const candidate = join(kits, version, "x64", "signtool.exe");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function packageName() {
  return /^name\s*=\s*"([^"]+)"/mu.exec(readFileSync(join(tauriDir, "Cargo.toml"), "utf8"))?.[1];
}

async function main() {
  if (process.platform !== "win32") throw new Error("Relo for Windows builds on Windows (the NSIS installer and signtool are Windows tools).");
  const options = parseArguments(process.argv.slice(2));
  const environment = buildEnvironment();
  const conf = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));
  const version = options.version ?? process.env.RELO_WINDOWS_VERSION ?? conf.version;
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`version ${version} must be MAJOR.MINOR.PATCH`);
  const work = mkdtempSync(join(tmpdir(), "relo-windows-app-"));

  try {
    // 1. The local-mode payload.
    let payload;
    if (options.server) {
      payload = process.env.RELO_WINDOWS_SERVER_PAYLOAD ? resolve(process.env.RELO_WINDOWS_SERVER_PAYLOAD) : undefined;
      const script = join(root, "scripts", "release", "windows-server-payload.mjs");
      if (!payload && existsSync(script)) {
        payload = join(work, "server-payload");
        say("building the local-mode payload");
        run(process.execPath, [script, payload, "--release-identity", version], { env: environment });
      }
      if (payload && !existsSync(payload)) throw new Error(`the server payload folder ${payload} does not exist`);
      // One release identity: this build's version. The app and ReloServer.exe both read it from the payload.
      if (payload) writeFileSync(join(payload, "release-identity.txt"), `${version}\n`);
      if (!payload) warn("no local-mode payload (scripts/release/windows-server-payload.mjs is missing and RELO_WINDOWS_SERVER_PAYLOAD is unset): the app is built remote-only");
    }

    // 2. The ReloServer.exe sidecar.
    let launcher;
    const binaries = join(tauriDir, "binaries");
    const sidecar = join(binaries, "ReloServer-x86_64-pc-windows-msvc.exe");
    if (options.server) {
      const crate = join(appDir, "server-launcher", "Cargo.toml");
      let built = process.env.RELO_WINDOWS_SERVER_LAUNCHER ? resolve(process.env.RELO_WINDOWS_SERVER_LAUNCHER) : undefined;
      if (!built && existsSync(crate)) {
        say("building ReloServer.exe");
        run("cargo", ["build", "--release", "--manifest-path", crate], { env: environment });
        const target = join(dirname(crate), "target", "release");
        built = ["ReloServer.exe", "reloserver.exe", "relo-server.exe"].map((name) => join(target, name)).find(existsSync);
        if (!built) throw new Error(`cargo built the launcher but no ReloServer.exe is in ${target}`);
      }
      if (built) {
        mkdirSync(binaries, { recursive: true });
        copyFileSync(built, sidecar);
        launcher = sidecar;
      } else warn("no ReloServer.exe (apps/windows/server-launcher is missing and RELO_WINDOWS_SERVER_LAUNCHER is unset): the app is built without it");
    }

    // 2b. Authenticode on the payload's own executables, before they are packed (the Mac signs every Mach-O the same way).
    const signCertificate = Boolean(signtoolArguments("x"));
    const carried = [...(payload ? payloadBinaries(payload) : []), ...(launcher ? [launcher] : [])];
    if (carried.length && signCertificate) {
      const signtool = findSigntool();
      if (!signtool) throw new Error("a certificate is set but signtool.exe was not found (Windows SDK)");
      say(`signing ${carried.length} payload executables`);
      for (const batch of inBatches(carried)) run(signtool, signtoolArguments(batch), { quiet: true });
      for (const file of carried) run(signtool, ["verify", "/pa", file], { quiet: true });
    } else if (carried.length && !options.unsigned) {
      warn(`${carried.length} payload executables (node.exe, ReloServer.exe, PostgreSQL) are UNSIGNED: no certificate (RELO_WINDOWS_CERT_FILE or RELO_WINDOWS_CERT_THUMBPRINT)`);
    }

    // 3. The installer.
    const config = join(work, "tauri.override.json");
    writeFileSync(config, JSON.stringify(configOverride({ payload, launcher, version: options.version ?? process.env.RELO_WINDOWS_VERSION,
      webview: process.env.RELO_WINDOWS_WEBVIEW2 })));
    say(`building the installer ${version}`);
    const bundleDir = join(tauriDir, "target", "release", "bundle", "nsis");
    rmSync(bundleDir, { recursive: true, force: true });
    run(process.execPath, [tauriCli(), "build", "--bundles", "nsis", "--ci", "--config", config], { cwd: appDir, env: environment });
    const built = readdirSync(bundleDir).find((name) => name.endsWith("-setup.exe"));
    if (!built) throw new Error(`the build produced no *-setup.exe in ${bundleDir}`);
    const setup = join(bundleDir, built);

    // 4. Authenticode.
    let signed = false;
    const signArgs = signtoolArguments(setup);
    if (signArgs) {
      const signtool = findSigntool();
      if (!signtool) throw new Error("a certificate is set (RELO_WINDOWS_CERT_FILE or RELO_WINDOWS_CERT_THUMBPRINT) but signtool.exe was not found (Windows SDK)");
      say("signing the installer");
      run(signtool, signArgs, { quiet: true });
      run(signtool, ["verify", "/pa", setup], { quiet: true });
      signed = "authenticode";
    } else if (!options.unsigned) {
      warn("no code-signing certificate (RELO_WINDOWS_CERT_FILE or RELO_WINDOWS_CERT_THUMBPRINT): the installer is UNSIGNED and Windows SmartScreen will warn people who run it");
    }

    // 4b. Relo Setup, the download: the signed NSIS installer inside Relo's own window.
    let download = setup;
    const setupCrate = join(appDir, "setup", "Cargo.toml");
    if (options.bootstrapper && existsSync(setupCrate)) {
      say("building Relo Setup");
      const build = setupBuild({ payload: setup, version, manifest: setupCrate });
      run("cargo", build.args, { env: { ...environment, ...build.env } });
      download = join(dirname(setupCrate), "target", "release", "relo-setup.exe");
      if (!existsSync(download)) throw new Error(`cargo built Relo Setup but ${download} is missing`);
      const signSetup = signtoolArguments(download);
      if (signSetup) {
        const signtool = findSigntool();
        say("signing Relo Setup");
        run(signtool, signSetup, { quiet: true });
        run(signtool, ["verify", "/pa", download], { quiet: true });
      }
    } else if (options.bootstrapper) {
      warn("apps/windows/setup is missing: the download is the plain NSIS installer, with its wizard");
    }

    // 5. The output folder: the download, update payload, signature.
    mkdirSync(options.out, { recursive: true });
    const outSetup = join(options.out, "relo-windows-setup.exe");
    const outZip = join(options.out, "relo-windows.zip");
    copyFileSync(download, outSetup);
    rmSync(outZip, { force: true });
    // The update payload is always the NSIS installer (the Tauri updater runs the program inside the zip).
    // The system's own tar writes the zip (bsdtar: -a picks the format from the name); Git Bash's tar would not.
    run(join(system32, "tar.exe"), ["-a", "-cf", outZip, "-C", bundleDir, built]);

    let signature;
    const key = process.env.TAURI_SIGNING_PRIVATE_KEY;
    if (key) {
      say("signing the update payload");
      const keyArgs = ["-k", existsSync(key) ? readFileSync(key, "utf8").trim() : key]; // the CLI also reads the variable as a literal key, so -f would conflict
      const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
      run(process.execPath, [tauriCli(), "signer", "sign", ...keyArgs, ...(password !== undefined ? ["-p", password] : []), outZip],
        { cwd: appDir, env: environment, quiet: true });
      signature = readFileSync(`${outZip}.sig`, "utf8").trim();
      rmSync(`${outZip}.sig`, { force: true });
    } else {
      warn("TAURI_SIGNING_PRIVATE_KEY is unset: the manifest carries no update signature, so this server offers no update feed");
    }

    // 6. The manifest.
    const executable = `${(conf.mainBinaryName ?? packageName() ?? "Relo")}.exe`;
    const manifest = manifestFor({ version, build: buildNumber(), critical: options.critical, sha256: sha256File(outSetup), executable, signature, notes: options.notes ?? "",
      pubDate: new Date().toISOString(), signed, zipSha256: sha256File(outZip), size: statSync(outSetup).size });
    writeFileSync(join(options.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    say(`done: ${outSetup} (${(manifest.size / 1048576).toFixed(1)} MB, ${signed ? "signed" : "unsigned"}${payload ? ", with the local server" : ", remote only"}${download !== setup ? ", Relo Setup window" : ", NSIS wizard"})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Real paths on both sides: a script started through a symlinked folder (macOS /var -> /private/var) still runs.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(`windows-app: ${error.message}`); process.exit(1); });
}
