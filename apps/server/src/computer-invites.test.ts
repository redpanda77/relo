import { execFile,execFileSync } from "node:child_process";
import { createECDH,createHash,randomBytes } from "node:crypto";
import { LOGIN_SCOPES,computerInviteStatusSchema } from "@relo/notification-contracts";
import { existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,renameSync,rmSync,writeFileSync } from "node:fs";
import { createServer,type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname,join } from "node:path";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test,vi } from "vitest";
import { createAccountAuth } from "./account-auth.js";
import { createApp } from "./app.js";
import { resetAuthAttempts } from "./auth-throttle.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import {
  bundledCli,bundledMacApp,bundledWindowsApp,createInviteSchema,installCommandWithoutCode,installScript,installScriptPowerShell,inviteCommand,macAppcast,
  windowsUpdateFeed,
} from "./computer-invites.js";
import { registerPublicComputerInviteRoutes } from "./api/computer-invite-routes.js";
import { createAuthDatabase,createDatabase,type Database } from "./db.js";
import { listClientKeys } from "./device-keys.js";
import { migrate } from "./migrate.js";
import { setupProgress } from "./web/setup-progress.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const appUrl = "http://127.0.0.1:8180";
const secret = "test-only-computer-invites-secret-0123456789abcdef";

test("the install script is POSIX sh, pins the CLI digest and joins with the code", () => {
  const script = installScript("https://relo.example",{ version: "0.17.30",sha256: "a".repeat(64),file: "/nowhere" });
  const file = join(mkdtempSync(join(tmpdir(),"relo-install-")),"install.sh");
  writeFileSync(file,script);
  execFileSync("sh",["-n",file]);
  expect(script).toContain("CLI_SHA256='" + "a".repeat(64) + "'");
  expect(script).toContain("\"$BIN/relo\" auth join \"$CODE\" --api-url \"$ORIGIN\"");
  expect(script).toContain("# relo launcher: $ENTRY");
  expect(script).not.toMatch(/sudo/);
  expect(script.indexOf('rm -f "$BIN/relo"')).toBeLessThan(script.indexOf('cat > "$BIN/relo"'));
  expect(script).toContain('rm -f "$BIN/relo"');
  // A cut-off download never runs half the script, and a new account (no startup file) still gets ~/.local/bin on PATH.
  expect(script.trimEnd().endsWith('main "$@"')).toBe(true);
  expect(script).toContain('[ -f "$RC" ] || continue');
  expect(script).toContain('*/zsh) RC="$HOME_DIR/.zshrc"');
  // A launcher Relo for Mac wrote is noticed before it is replaced, and the CLI then updates itself again.
  expect(script.indexOf("# Written by Relo for Mac")).toBeLessThan(script.indexOf('rm -f "$BIN/relo"'));
  expect(script.indexOf('"$BIN/relo" update --mode auto')).toBeGreaterThan(script.indexOf('chmod 755 "$BIN/relo"'));
});

test("the install script switches a Mac-app launcher's CLI back to self-updates, and leaves others alone",() => {
  const dir = mkdtempSync(join(tmpdir(),"relo-install-mac-"));
  const bin = join(dir,"home",".local","bin");
  mkdirSync(bin,{ recursive: true });
  // Run only the launcher section (marker check, replacement, update) with a Node stub that logs its arguments.
  const script = installScript("https://relo.example",{ version: "0.17.30",sha256: "a".repeat(64),file: "/nowhere" });
  const section = script.slice(script.indexOf('FROM_MAC_APP=""'),script.indexOf("RELO=relo"));
  const node = join(dir,"node");
  writeFileSync(node,'#!/bin/sh\necho "$@" >> "$(dirname "$0")/calls.log"\n',{ mode: 0o755 });
  for (const [existing,expected] of [["# Written by Relo for Mac","entry update --mode auto"],["# something else",null]] as const) {
    rmSync(join(dir,"calls.log"),{ force: true });
    writeFileSync(join(bin,"relo"),`#!/bin/sh\n${existing}\nexec x\n`);
    writeFileSync(join(dir,"run.sh"),`set -eu\nBIN='${bin}'; ENTRY=entry; NODE='${node}'\nsay() { :; }\n${section}\n`);
    execFileSync("sh",[join(dir,"run.sh")]);
    expect(existsSync(join(dir,"calls.log")) ? readFileSync(join(dir,"calls.log"),"utf8").trim() : null).toBe(expected);
  }
});

test("the server hands out Relo for Mac only with both its manifest and its zip", () => {
  const dir = mkdtempSync(join(tmpdir(),"relo-mac-"));
  const url = new URL(`file://${dir}/`);
  expect(bundledMacApp(url)).toBeNull();
  writeFileSync(join(dir,"manifest.json"),JSON.stringify({ version: "0.1.0+1",sha256: "c".repeat(64),app: "Relo Notch.app",executable: "Relo Notch" }));
  expect(bundledMacApp(url)).toBeNull();
  writeFileSync(join(dir,"relo-mac.zip"),"zip");
  expect(bundledMacApp(url)).toMatchObject({ version: "0.1.0+1",app: "Relo Notch.app",executable: "Relo Notch" });
  // No EdDSA signature: no update feed.
  expect(macAppcast("https://relo.example",bundledMacApp(url))).toBeNull();
  // The DMG people download (plan 16) is offered only when it sits beside the zip.
  expect(bundledMacApp(url)?.dmg).toBeUndefined();
  writeFileSync(join(dir,"relo-mac.dmg"),"dmg");
  expect(bundledMacApp(url)?.dmg).toBe(join(dir,"relo-mac.dmg"));
});

describe("RELO_ARTIFACTS_DIR", () => {
  const cliManifest = (version: string) => JSON.stringify({ version,sha256: "d".repeat(64) });
  const macManifest = (version: string) => JSON.stringify({ version,sha256: "e".repeat(64),app: "Relo Notch.app",executable: "Relo Notch" });
  const publish = (dir: string,kind: "cli" | "mac",manifest: string) => {
    mkdirSync(join(dir,kind),{ recursive: true });
    writeFileSync(join(dir,kind,kind === "cli" ? "relo-cli.tgz" : "relo-mac.zip"),"x");
    writeFileSync(join(dir,kind,"manifest.json"),manifest);
  };
  const image = (kind: "cli" | "mac",manifest: string) => {
    const dir = mkdtempSync(join(tmpdir(),"relo-image-"));
    publish(dir,kind,manifest);
    return new URL(`file://${dir}/${kind}/`);
  };
  const withEnv = (dir: string | undefined,body: () => void) => {
    const before = process.env.RELO_ARTIFACTS_DIR;
    if (dir === undefined) delete process.env.RELO_ARTIFACTS_DIR; else process.env.RELO_ARTIFACTS_DIR = dir;
    try { body(); } finally { if (before === undefined) delete process.env.RELO_ARTIFACTS_DIR; else process.env.RELO_ARTIFACTS_DIR = before; }
  };

  test("the folder wins over the image when it holds a valid manifest, else the image's is served", () => {
    const dir = mkdtempSync(join(tmpdir(),"relo-artifacts-"));
    const bundled = image("cli",cliManifest("1.0.0"));
    const bundledMac = image("mac",macManifest("1.0.0"));
    withEnv(dir,() => {
      publish(dir,"cli",cliManifest("2.0.0"));
      expect(bundledCli()).toMatchObject({ version: "2.0.0",file: join(dir,"cli","relo-cli.tgz") });
      publish(dir,"mac",macManifest("2.0.0"));
      expect(bundledMacApp()).toMatchObject({ version: "2.0.0",file: join(dir,"mac","relo-mac.zip") });
    });
    // An explicit directory (the image's) is read as before, whatever the environment says.
    withEnv(dir,() => {
      expect(bundledCli(bundled)?.version).toBe("1.0.0");
      expect(bundledMacApp(bundledMac)?.version).toBe("1.0.0");
    });
  });

  test("an invalid, partial or missing folder is ignored, and a later valid file is picked up", () => {
    const dir = mkdtempSync(join(tmpdir(),"relo-artifacts-"));
    withEnv(dir,() => {
      mkdirSync(join(dir,"cli"));
      writeFileSync(join(dir,"cli","manifest.json"),"{not json");
      expect(bundledCli()).toBeNull();
      writeFileSync(join(dir,"cli","manifest.json"),JSON.stringify({ version: "2.0.0",sha256: "short" }));
      expect(bundledCli()).toBeNull();
      writeFileSync(join(dir,"cli","manifest.json"),cliManifest("2.0.0")); // a manifest without its tarball is no CLI
      expect(bundledCli()).toBeNull();
      writeFileSync(join(dir,"cli","relo-cli.tgz"),"x");
      expect(bundledCli()?.version).toBe("2.0.0");
    });
    withEnv("relative/path",() => expect(bundledCli()).toBeNull());
    withEnv(join(dir,"missing"),() => expect(bundledMacApp()).toBeNull());
  });

  test("a manifest replaced in place (atomic rename) is read on the next call", () => {
    const dir = mkdtempSync(join(tmpdir(),"relo-artifacts-"));
    withEnv(dir,() => {
      publish(dir,"cli",cliManifest("2.0.0"));
      expect(bundledCli()?.version).toBe("2.0.0");
      writeFileSync(join(dir,"cli","manifest.tmp"),cliManifest("2.0.1"));
      renameSync(join(dir,"cli","manifest.tmp"),join(dir,"cli","manifest.json"));
      expect(bundledCli()?.version).toBe("2.0.1");
      publish(dir,"mac",macManifest("3.0.0"));
      writeFileSync(join(dir,"mac","manifest.tmp"),macManifest("3.0.1"));
      renameSync(join(dir,"mac","manifest.tmp"),join(dir,"mac","manifest.json"));
      expect(bundledMacApp()?.version).toBe("3.0.1");
    });
  });
});

test("Relo for Mac's update feed names the signed build the server hands out", () => {
  const dir = mkdtempSync(join(tmpdir(),"relo-mac-"));
  writeFileSync(join(dir,"relo-mac.zip"),"zip");
  const edSignature = "A".repeat(86) + "==";
  writeFileSync(join(dir,"manifest.json"),JSON.stringify({ version: "0.1.1+260",shortVersion: "0.1.1",build: "260",sha256: "c".repeat(64),
    app: "Relo Notch.app",executable: "Relo Notch",edSignature,length: 10287197,minimumSystemVersion: "14.0" }));
  const feed = macAppcast("https://relo.example",bundledMacApp(new URL(`file://${dir}/`)))!;
  expect(feed).toContain("<sparkle:version>260</sparkle:version>");
  expect(feed).toContain("<sparkle:shortVersionString>0.1.1</sparkle:shortVersionString>");
  expect(feed).toContain(`<enclosure url="https://relo.example/mac/relo-mac.zip" length="10287197" type="application/octet-stream" sparkle:edSignature="${edSignature}"/>`);
  expect(feed).toContain("<sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>");
  expect(feed).toContain("<sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>");
});

test("the install script installs Relo for Mac only on a Mac, when asked and the server has it, and hands it to the join", () => {
  const cli = { version: "0.17.30",sha256: "a".repeat(64),file: "/nowhere" };
  const mac = { version: "0.1.0+255",sha256: "b".repeat(64),app: "Relo Notch.app",executable: "Relo Notch",file: "/nowhere" };
  const script = installScript("https://relo.example",cli,mac);
  const file = join(mkdtempSync(join(tmpdir(),"relo-install-")),"install.sh");
  writeFileSync(file,script);
  execFileSync("sh",["-n",file]);
  expect(script).toContain("MAC_SHA256='" + "b".repeat(64) + "'");
  expect(script).toContain('--mac-app) WANT_MAC=1 ;;');
  expect(script).toContain('[ "$(uname -s)" != Darwin ]');
  expect(script).toContain('fetch "$ORIGIN/mac/relo-mac.zip" "$WORK/relo-mac.zip"');
  expect(script).toContain('--mac-app "$APP"');
  // A server without the app says so instead of failing.
  expect(installScript("https://relo.example",cli)).toContain("MAC_SHA256=''");
});

test("the install script replaces an installed Relo.app where it is and leaves no second copy", () => {
  const script = installScript("https://relo.example",{ version: "0.17.30",sha256: "a".repeat(64),file: "/nowhere" },
    { version: "0.1.0+255",sha256: "b".repeat(64),app: "Relo Notch.app",executable: "Relo Notch",file: "/nowhere" });
  const start = script.indexOf("# An installed Relo.app is replaced where it is");
  const end = script.indexOf('mv "$WORK/mac/$MAC_APP_NAME" "$APP"');
  expect(start).toBeGreaterThan(0);
  const block = script.slice(start,end + 'mv "$WORK/mac/$MAC_APP_NAME" "$APP"'.length);
  expect(block).toContain("/Applications");
  const root = mkdtempSync(join(tmpdir(),"relo-app-replace-"));
  const name = "Relo Replace Test.app";
  mkdirSync(join(root,"work","mac",name),{ recursive: true });
  writeFileSync(join(root,"work","mac",name,"new"),"new");
  mkdirSync(join(root,"home","Applications",name),{ recursive: true });
  writeFileSync(join(root,"home","Applications",name,"old"),"old");
  const out = execFileSync("sh",["-c",`set -e; HOME_DIR="${root}/home"; WORK="${root}/work"; MAC_APP_NAME="${name}"\n${block}\necho "$APP"`]).toString().trim();
  expect(out).toBe(join(root,"home","Applications",name));
  expect(existsSync(join(out,"new"))).toBe(true);
  expect(existsSync(join(out,"old"))).toBe(false);
});

test("inviteCommand makes one command per shell family, with the desktop app on request", () => {
  expect(inviteCommand("https://relo.example","rci_x")).toEqual({
    posix: "curl -fsSL https://relo.example/install.sh | sh -s -- rci_x",
    windows: "& ([scriptblock]::Create((irm https://relo.example/install.ps1))) rci_x",
  });
  expect(inviteCommand("https://relo.example","rci_x",true)).toEqual({
    posix: "curl -fsSL https://relo.example/install.sh | sh -s -- rci_x --mac-app",
    windows: "& ([scriptblock]::Create((irm https://relo.example/install.ps1))) rci_x -WindowsApp",
  });
  expect(installCommandWithoutCode("https://relo.example")).toEqual({
    posix: "curl -fsSL https://relo.example/install.sh | sh",windows: "irm https://relo.example/install.ps1 | iex",
  });
  const parsed = createInviteSchema.parse({ macApp: true });
  expect(parsed).toMatchObject({ desktopApp: false,macApp: true });
});

describe("Relo for Windows",() => {
  const windowsManifest = (extra: object = {}) => JSON.stringify({ version: "0.1.0",sha256: "f".repeat(64),...extra });
  const folder = (files: Record<string,string>) => {
    const dir = mkdtempSync(join(tmpdir(),"relo-windows-"));
    for (const [name,contents] of Object.entries(files)) writeFileSync(join(dir,name),contents);
    return dir;
  };
  const signature = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUZXN0U2lnbmF0dXJl";

  test("the server hands it out only with both its manifest and its installer; the update feed also needs the signed zip",() => {
    const dir = mkdtempSync(join(tmpdir(),"relo-windows-"));
    const url = new URL(`file://${dir.replaceAll("\\","/").replace(/^([A-Za-z]):/,"/$1:")}/`);
    expect(bundledWindowsApp(url)).toBeNull();
    writeFileSync(join(dir,"manifest.json"),windowsManifest());
    expect(bundledWindowsApp(url)).toBeNull();
    writeFileSync(join(dir,"relo-windows-setup.exe"),"exe");
    expect(bundledWindowsApp(url)).toMatchObject({ version: "0.1.0",sha256: "f".repeat(64),executable: "Relo.exe",file: join(dir,"relo-windows-setup.exe") });
    // No signature and zip: no update feed.
    expect(windowsUpdateFeed("https://relo.example",bundledWindowsApp(url))).toBeNull();
    writeFileSync(join(dir,"manifest.json"),windowsManifest({ signature,notes: "Fixes.",pubDate: "2026-10-24T10:00:00Z" }));
    expect(windowsUpdateFeed("https://relo.example",bundledWindowsApp(url))).toBeNull();
    writeFileSync(join(dir,"relo-windows.zip"),"zip");
    expect(windowsUpdateFeed("https://relo.example",bundledWindowsApp(url))).toEqual({
      version: "0.1.0",notes: "Fixes.",pub_date: "2026-10-24T10:00:00.000Z",
      platforms: { "windows-x86_64": { signature,url: "https://relo.example/windows/relo-windows.zip" } },
    });
    // A critical build says so in the feed (the app's "Important update"); anything but true is ignored.
    writeFileSync(join(dir,"manifest.json"),windowsManifest({ signature,notes: "Fixes.",pubDate: "2026-10-24T10:00:00Z",critical: true }));
    expect(windowsUpdateFeed("https://relo.example",bundledWindowsApp(url))).toMatchObject({ version: "0.1.0",critical: true });
    writeFileSync(join(dir,"manifest.json"),windowsManifest({ signature,critical: "yes" }));
    expect(windowsUpdateFeed("https://relo.example",bundledWindowsApp(url))).not.toHaveProperty("critical");
    // A bad digest, version or executable name is no manifest.
    for (const bad of [{ sha256: "short" },{ version: "../x" },{ executable: "../Relo.exe" },{ executable: "Relo.bat" }]) {
      writeFileSync(join(dir,"manifest.json"),windowsManifest(bad));
      expect(bundledWindowsApp(url)).toBeNull();
    }
  });

  test("RELO_ARTIFACTS_DIR/windows wins over the image's, and is read on every call",() => {
    const dir = folder({});
    mkdirSync(join(dir,"windows"));
    writeFileSync(join(dir,"windows","relo-windows-setup.exe"),"exe");
    writeFileSync(join(dir,"windows","manifest.json"),windowsManifest({ version: "2.0.0" }));
    const before = process.env.RELO_ARTIFACTS_DIR;
    process.env.RELO_ARTIFACTS_DIR = dir;
    try {
      expect(bundledWindowsApp()).toMatchObject({ version: "2.0.0",file: join(dir,"windows","relo-windows-setup.exe") });
      writeFileSync(join(dir,"windows","manifest.json"),windowsManifest({ version: "2.0.1" }));
      expect(bundledWindowsApp()?.version).toBe("2.0.1");
    } finally { if (before === undefined) delete process.env.RELO_ARTIFACTS_DIR; else process.env.RELO_ARTIFACTS_DIR = before; }
  });

  test("the routes serve the script, the installer, the update payload and the feed, and 404 without them",async () => {
    const dir = mkdtempSync(join(tmpdir(),"relo-artifacts-"));
    mkdirSync(join(dir,"cli"));
    mkdirSync(join(dir,"windows"));
    writeFileSync(join(dir,"cli","relo-cli.tgz"),"tgz");
    writeFileSync(join(dir,"cli","manifest.json"),JSON.stringify({ version: "1.2.3",sha256: "a".repeat(64) }));
    const app = new Hono();
    registerPublicComputerInviteRoutes(app,{} as Database,"https://relo.example");
    const before = process.env.RELO_ARTIFACTS_DIR;
    process.env.RELO_ARTIFACTS_DIR = dir;
    try {
      // The server carries the CLI but no Windows app: the script says so, the downloads are 404.
      const script = await app.request("/install.ps1");
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toContain("text/plain");
      expect(script.headers.get("cache-control")).toBe("no-store");
      expect(await script.text()).toContain("$AppSha256 = ''");
      for (const path of ["/windows/relo-setup.exe","/windows/relo-windows.zip","/windows/update.json"]) expect((await app.request(path)).status).toBe(404);
      writeFileSync(join(dir,"windows","relo-windows-setup.exe"),"the installer");
      writeFileSync(join(dir,"windows","relo-windows.zip"),"the payload");
      writeFileSync(join(dir,"windows","manifest.json"),windowsManifest({ signature,pubDate: "2026-10-24T10:00:00Z" }));
      expect(await (await app.request("/install.ps1")).text()).toContain(`$AppSha256 = '${"f".repeat(64)}'`);
      const exe = await app.request("/windows/relo-setup.exe");
      expect(exe.status).toBe(200);
      expect(await exe.text()).toBe("the installer");
      expect(exe.headers.get("x-relo-windows-sha256")).toBe("f".repeat(64));
      expect(exe.headers.get("content-disposition")).toContain("attachment");
      expect(await (await app.request("/windows/relo-windows.zip")).text()).toBe("the payload");
      const feed = await app.request("/windows/update.json");
      expect(feed.status).toBe(200);
      expect(await feed.json()).toEqual({ version: "0.1.0",notes: "",pub_date: "2026-10-24T10:00:00.000Z",
        platforms: { "windows-x86_64": { signature,url: "https://relo.example/windows/relo-windows.zip" } } });
      // A server without a CLI hands out no script.
      rmSync(join(dir,"cli","manifest.json"));
      expect((await app.request("/install.ps1")).status).toBe(503);
    } finally { if (before === undefined) delete process.env.RELO_ARTIFACTS_DIR; else process.env.RELO_ARTIFACTS_DIR = before; }
  });
});

const psCli = { version: "0.17.30",sha256: "a".repeat(64),file: "/nowhere" };
const psApp = { version: "0.1.0",sha256: "b".repeat(64),executable: "Relo.exe",file: "/nowhere" };
const powershell = join(process.env.SystemRoot ?? "C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");

test("the install script pins both digests, names no deployment and is ASCII with LF line ends",() => {
  const script = installScriptPowerShell("https://relo.example",psCli,psApp);
  expect(script).toContain("$CliSha256 = '" + "a".repeat(64) + "'");
  expect(script).toContain("$AppSha256 = '" + "b".repeat(64) + "'");
  expect(script).toContain("$Origin = 'https://relo.example'");
  expect(script).toContain("System32\\tar.exe");
  expect(script).toContain("/windows/relo-setup.exe");
  expect(script).toContain("Written by Relo for Windows");
  expect(script).toContain("DoNotExpandEnvironmentNames");
  expect(script).toContain("SendMessageTimeout");
  expect(script).not.toMatch(/sudo|RunAs|-Verb/);
  // eslint-disable-next-line no-control-regex
  expect(/^[\x09\x0a\x20-\x7e]*$/.test(script)).toBe(true);
  expect(script).not.toContain("\r");
  // A cut-off download never runs half the script: everything is in the function the last line calls.
  expect(script.trimEnd().endsWith("Install-Relo $args")).toBe(true);
  expect(installScriptPowerShell("https://relo.example",psCli)).toContain("$AppSha256 = ''");
});

test.runIf(process.platform === "win32")("the install script parses in Windows PowerShell",() => {
  const file = join(mkdtempSync(join(tmpdir(),"relo-install-ps-")),"install.ps1");
  writeFileSync(file,installScriptPowerShell("https://relo.example",psCli,psApp));
  const parse = `$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e);if($e.Count){$e|%{$_.Message};exit 1}`;
  execFileSync(powershell,["-NoProfile","-NonInteractive","-Command",parse]);
});

// The generated script, run for real in an isolated profile against a local server (nothing leaves this machine except
// when Node must be downloaded; the user Path is skipped with -NoPath, so the registry is never written).
describe.runIf(process.platform === "win32")("install.ps1 in an isolated profile",() => {
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows","System32");
  const csc = join(process.env.SystemRoot ?? "C:\\Windows","Microsoft.NET","Framework64","v4.0.30319","csc.exe");
  let server: Server,origin: string,work: string,tgz: Buffer,setupExe: Buffer,serveTgz: Buffer | undefined;
  const hits: string[] = [];

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(),"relo-ps-e2e-"));
    // A CLI that records how it was called (the real one is exercised by its own tests).
    const stage = join(work,"stage","package","bin");
    mkdirSync(stage,{ recursive: true });
    writeFileSync(join(stage,"relo.mjs"),`import { appendFileSync } from "node:fs";\nappendFileSync(process.env.RELO_STUB_OUT, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
    execFileSync(join(system32,"tar.exe"),["-czf",join(work,"relo-cli.tgz"),"-C",join(work,"stage"),"package"]);
    tgz = readFileSync(join(work,"relo-cli.tgz"));
    // A stand-in installer: `setup.exe /S /D=dir` puts a Relo.exe in dir, as the NSIS one does; Relo.exe records its arguments.
    writeFileSync(join(work,"stub.cs"),`using System; using System.IO; using System.Reflection;
class P { static int Main(string[] a) {
  string me = Assembly.GetExecutingAssembly().Location, d = null;
  foreach (var x in a) if (x.StartsWith("/D=")) d = x.Substring(3);
  if (d != null) { Directory.CreateDirectory(d); File.Copy(me, Path.Combine(d, "Relo.exe"), true); return 0; }
  File.WriteAllText(Path.Combine(Path.GetDirectoryName(me), "launched.txt"), string.Join("|", a)); return 0; } }`);
    execFileSync(csc,["/nologo",`/out:${join(work,"setup.exe")}`,join(work,"stub.cs")]);
    setupExe = readFileSync(join(work,"setup.exe"));
    server = createServer((request,response) => {
      hits.push(request.url ?? "");
      if (request.url === "/cli/relo-cli.tgz") response.end(serveTgz ?? tgz);
      else if (request.url === "/windows/relo-setup.exe") response.end(setupExe);
      else { response.statusCode = 404; response.end(); }
    });
    await new Promise<void>((done) => server.listen(0,"127.0.0.1",done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  },120_000);
  afterAll(() => { server?.close(); });
  beforeEach(() => { hits.length = 0; serveTgz = undefined; });

  const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  /** Runs the generated script in a fresh profile; returns the profile, the output and the exit code. */
  // Asynchronous: the server above lives in this process, so a blocking spawn would starve the downloads the script makes.
  const spawnAsync = (file: string,args: string[],options: { env: NodeJS.ProcessEnv; timeout: number }) => new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = execFile(file,args,{ ...options,encoding: "utf8",windowsHide: true },(error,stdout,stderr) => {
      done({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0,stdout: String(stdout),stderr: String(stderr) });
    });
    child.stdin?.end();
  });
  async function runScript(args: string[],{ app = true,path = process.env.PATH }: { app?: boolean; path?: string } = {}) {
    const profile = mkdtempSync(join(work,"profile-"));
    const local = join(profile,"AppData","Local");
    mkdirSync(local,{ recursive: true });
    mkdirSync(join(profile,"AppData","Roaming"),{ recursive: true });
    mkdirSync(join(profile,"tmp"));
    const script = join(profile,"install.ps1");
    writeFileSync(script,installScriptPowerShell(origin,{ version: "9.9.9",sha256: sha(tgz),file: "/nowhere" },
      app ? { version: "0.1.0",sha256: sha(setupExe),executable: "Relo.exe",file: "/nowhere" } : null));
    const out = join(profile,"relo-calls.txt");
    const result = await spawnAsync(powershell,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",script,...args],{
      timeout: 300_000,
      env: { ...process.env,USERPROFILE: profile,HOME: profile,LOCALAPPDATA: local,APPDATA: join(profile,"AppData","Roaming"),
        TEMP: join(profile,"tmp"),TMP: join(profile,"tmp"),RELO_STUB_OUT: out,
        PATH: path,RELO_INSTALL_NO_PATH: "" } });
    return { profile,local,out,status: result.status,text: `${result.stdout}${result.stderr}` };
  }
  const nodeOnPath = `${dirname(process.execPath)};${join(process.env.SystemRoot ?? "C:\\Windows","System32")};${join(process.env.SystemRoot ?? "C:\\Windows","System32","WindowsPowerShell","v1.0")}`;

  test("installs the CLI, writes the launcher Relo's own parser recognizes, installs the app and joins with it",async () => {
    const code = `rci_${"a".repeat(32)}.${"b".repeat(22)}`;
    const run = await runScript([code,"-WindowsApp","-NoPath"],{ path: nodeOnPath });
    expect(run.status,run.text).toBe(0);
    const root = join(run.local,"Relo");
    // The CLI, unpacked by the system tar into its versioned folder.
    const entry = join(root,"cli","9.9.9","bin","relo.mjs");
    expect(existsSync(entry)).toBe(true);
    // The launcher is the format windows-launcher.mjs writes and recognizes, naming Node and the entry by absolute path.
    const launcher = await import(pathToFileURL(join(process.cwd(),"..","..","packages","cli","src","owner","windows-launcher.mjs")).href);
    const nodeExe = readFileSync(join(root,"bin","relo.cmd"),"utf8").match(/^"([^"]+)" "/m)![1]!;
    expect(nodeExe.toLowerCase()).toBe(process.execPath.toLowerCase());
    expect(readFileSync(join(root,"bin","relo.cmd"),"utf8")).toBe(launcher.cmdLauncherText(nodeExe,entry));
    expect(readFileSync(join(root,"bin","relo"),"utf8")).toBe(launcher.shLauncherText(nodeExe,entry));
    expect(launcher.parseCmdLauncher(readFileSync(join(root,"bin","relo.cmd"),"utf8"))).toMatchObject({ node: nodeExe,entry,managed: false });
    expect(readFileSync(join(root,"bin","relo.cmd")).subarray(0,3).toString("hex")).not.toBe("efbbbf");
    // The app: installed per user where /D= said, and the join was told its path.
    const app = join(run.local,"Programs","Relo","Relo.exe");
    expect(existsSync(app)).toBe(true);
    const calls = readFileSync(run.out,"utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0,2)).toEqual(["auth","join"]);
    expect(calls[0][2]).toBe(code);
    expect(calls[0]).toEqual(expect.arrayContaining(["--api-url",origin,"--client-name",process.env.COMPUTERNAME,"--windows-app",app]));
    expect(hits.sort()).toEqual(["/cli/relo-cli.tgz","/windows/relo-setup.exe"]);
    // Nothing is left behind in the temp folder.
    expect(readdirSync(join(run.profile,"tmp")).filter((name) => name.startsWith("relo-"))).toEqual([]);
    // Running it again replaces the CLI folder and the launcher in place.
    const again = await runScript([code,"-NoPath"],{ path: nodeOnPath });
    expect(again.status,again.text).toBe(0);
  },300_000);

  test("without a code it installs the CLI only and says what to run next; without -WindowsApp no app is fetched",async () => {
    const run = await runScript(["-NoPath"],{ path: nodeOnPath });
    expect(run.status,run.text).toBe(0);
    expect(run.text).toContain("auth login --api-url " + origin);
    expect(existsSync(join(run.local,"Relo","bin","relo.cmd"))).toBe(true);
    expect(existsSync(run.out)).toBe(false);
    expect(hits).toEqual(["/cli/relo-cli.tgz"]);
  },120_000);

  test("-WindowsApp on a server with no app skips it and still joins",async () => {
    const run = await runScript([`rci_${"a".repeat(32)}`,"-WindowsApp","-NoPath"],{ app: false,path: nodeOnPath });
    expect(run.status,run.text).toBe(0);
    expect(run.text).toContain("no Relo for Windows to install");
    expect(JSON.parse(readFileSync(run.out,"utf8").trim())).not.toContain("--windows-app");
    expect(hits).toEqual(["/cli/relo-cli.tgz"]);
  },120_000);

  test("a download that does not match its digest installs nothing",async () => {
    serveTgz = Buffer.from("not the cli");
    const run = await runScript([`rci_${"a".repeat(32)}`,"-NoPath"],{ path: nodeOnPath });
    expect(run.status).not.toBe(0);
    expect(run.text).toContain("did not match its checksum");
    expect(existsSync(join(run.local,"Relo","bin","relo.cmd"))).toBe(false);
  },120_000);

  test("an unknown option fails before anything is downloaded",async () => {
    const run = await runScript(["-Bogus"],{ path: nodeOnPath });
    expect(run.status).not.toBe(0);
    expect(run.text).toContain("unknown option -Bogus");
    expect(hits).toEqual([]);
  },120_000);

  test("a launcher Relo for Windows wrote is left alone",async () => {
    const profile = await runScript(["-NoPath"],{ path: nodeOnPath });
    const cmd = join(profile.local,"Relo","bin","relo.cmd");
    writeFileSync(cmd,"@echo off\r\nrem Written by Relo for Windows\r\nrem relo launcher: C:\\x\\relo.mjs\r\n\"C:\\x\\node.exe\" \"C:\\x\\relo.mjs\" %*\r\n");
    const second = join(profile.profile,"again.ps1");
    writeFileSync(second,installScriptPowerShell(origin,{ version: "9.9.9",sha256: sha(tgz),file: "/nowhere" }));
    const result = await spawnAsync(powershell,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",second,"-NoPath"],{ timeout: 300_000,
      env: { ...process.env,USERPROFILE: profile.profile,LOCALAPPDATA: profile.local,TEMP: join(profile.profile,"tmp"),TMP: join(profile.profile,"tmp"),PATH: nodeOnPath } });
    expect(result.status,`${result.stdout}${result.stderr}`).toBe(0);
    expect(readFileSync(cmd,"utf8")).toContain("Written by Relo for Windows");
    expect(readFileSync(cmd,"utf8")).toContain("C:\\x\\node.exe");
  },300_000);

  test("without Node 22 on PATH it installs the official zip, checked against nodejs.org's SHASUMS256",async () => {
    // Only System32 on PATH: this machine's Node is out of reach, so the script must fetch and verify its own.
    const run = await runScript(["-NoPath"],{ path: `${system32};${join(system32,"WindowsPowerShell","v1.0")}` });
    expect(run.status,run.text).toBe(0);
    expect(run.text).toContain("installing Node.js 22");
    const node = join(run.local,"Relo","node","node.exe");
    expect(existsSync(node)).toBe(true);
    expect(execFileSync(node,["-p","process.versions.node.split('.')[0]"],{ encoding: "utf8" }).trim()).toBe("22");
    expect(readFileSync(join(run.local,"Relo","bin","relo.cmd"),"utf8")).toContain(`"${node}"`);
  },600_000);
});

// Add a computer (docs/site/guides/servers.md): a trusted device makes a one-time code; the new computer redeems it once.
suite("computer invites",() => {
  let db: Database,authDb: Database,app: ReturnType<typeof createApp>,principalId: string,owner: string;

  beforeAll(async () => {
    resetAuthAttempts();
    db = createDatabase(databaseUrl!);
    authDb = createAuthDatabase(databaseUrl!);
    await migrate(db);
    app = createApp(db,{ accountAuth: createAccountAuth(authDb,appUrl,secret),bootstrapOwnerHandle: "owner",
      credentialDerivationSecret: secret,appUrl,apnsMode: "sandbox" });
  });
  afterAll(async () => { await Promise.all([db.end(),authDb.end()]); });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    owner = "computer_invites_owner_abcdefghijklmnopqrstuvwxyz_0123";
    await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });

  async function call(token: string | null,method: string,path: string,body?: unknown) {
    const response = await app.request(path,{ method,headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json","idempotency-key": randomUUID() },body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }

  async function phone() {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment) VALUES ($1,$2,$3,'iPhone','com.example.relo.notifications','1','1','26','sandbox')
      RETURNING id`,[principalId,randomUUID(),randomUUID()])).rows[0]!.id;
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [id,hashToken(credential)]);
    return credential;
  }

  const redeem = (code: string,clientName = "Build box",scopes: readonly string[] = ["notifications:send","interactions:read"]) =>
    call(null,"POST","/api/computer-invites/redeem",{ code,clientName,scopes,expiresInSeconds: 86_400 });
  // What `relo auth join` asks for: every scope a login may hold.
  const joinScopes = LOGIN_SCOPES;
  const internalLoginId = (clientId: string) => clientId.slice("key_".length);

  test("a phone makes a code; the new computer redeems it once for its own login, with the setup the owner chose",async () => {
    const made = await call(await phone(),"POST","/api/devices/self/computer-invites",{ level: "guide",approvals: true,agents: ["claude-code","opencode"] });
    expect(made.status).toBe(201);
    expect(made.body.code).toMatch(/^rci_[A-Za-z0-9_-]{32}$/);
    expect(made.body.command).toBe(`curl -fsSL ${appUrl}/install.sh | sh -s -- ${made.body.code}`);
    expect(made.body.commands).toEqual({ posix: made.body.command,
      windows: `& ([scriptblock]::Create((irm ${appUrl}/install.ps1))) ${made.body.code}` });
    expect(made.body.desktopApp).toBe(false);
    const joined = await redeem(made.body.code);
    expect(joined.status).toBe(200);
    expect(joined.body.accessToken).toMatch(/^relo_/);
    expect(joined.body.credential.clientName).toBe("Build box");
    expect(joined.body.setup).toEqual({ level: "guide",approvals: true,agents: ["claude-code","opencode"],desktopApp: false });
    expect(joined.body.desktopAppSignInCode).toBeUndefined();
    expect(joined.body.macAppSignInCode).toBeUndefined();
    expect((await call(joined.body.accessToken,"GET","/api/clients/self")).status).toBe(200);
    // Once only.
    expect((await redeem(made.body.code,"Other box")).body.error).toBe("invalid_code");
    expect((await db.query("SELECT count(*)::int AS n FROM computer_invites WHERE principal_id=$1 AND redeemed_at IS NOT NULL",[principalId])).rows[0].n).toBe(1);
  });

  test("a code made with Relo for Mac hands the installer a one-time sign-in code the Mac app exchanges with its verifier",async () => {
    const subject = `computer-invites-owner-${randomUUID()}`;
    await db.query("INSERT INTO auth.users(id,name,email) VALUES ($1,'Owner',$2)",[subject,`${subject}@relo.example`]);
    await db.query(`INSERT INTO account_identities(principal_id,provider,subject,role,approved_at) VALUES ($1,'better-auth',$2,'owner',now())`,
      [principalId,subject]);
    const made = await call(await phone(),"POST","/api/devices/self/computer-invites",{ desktopApp: true });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ desktopApp: true });
    expect(made.body.command).toBe(`curl -fsSL ${appUrl}/install.sh | sh -s -- ${made.body.code} --mac-app`);
    expect(made.body.commands.windows).toBe(`& ([scriptblock]::Create((irm ${appUrl}/install.ps1))) ${made.body.code} -WindowsApp`);
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const joined = await call(null,"POST","/api/computer-invites/redeem",{ code: made.body.code,clientName: "Mac box",
      scopes: ["notifications:send"],expiresInSeconds: 86_400,desktopAppChallenge: challenge });
    expect(joined.status).toBe(200);
    expect(joined.body.setup.desktopApp).toBe(true);
    expect(joined.body.desktopAppSignInCode).toMatch(/^relo_signin_[A-Za-z0-9_-]{43}$/);
    // The old names still work for clients that predate desktopApp.
    expect(joined.body.macAppSignInCode).toBe(joined.body.desktopAppSignInCode);
    // Only the verifier opens it, once.
    const exchange = (codeVerifier: string) => call(null,"POST","/api/mobile/sign-in/token",
      { code: joined.body.desktopAppSignInCode,codeVerifier,installationId: "mac-installation-1" });
    expect((await exchange(randomBytes(32).toString("base64url"))).body.error).toBe("invalid_grant");
    const session = await exchange(verifier);
    expect(session.status).toBe(200);
    expect(session.body.user.email).toBe(`${subject}@relo.example`);
    expect((await exchange(verifier)).body.error).toBe("invalid_grant");
  });

  test("a code made with the old macApp name is a desktop app code, and its old challenge name still redeems",async () => {
    const made = await call(await phone(),"POST","/api/devices/self/computer-invites",{ macApp: true });
    expect(made.body.desktopApp).toBe(true);
    expect(made.body.commands.windows).toContain(" -WindowsApp");
  });

  test("a code made without Relo for Mac never hands out a sign-in code, whatever the redeem asks",async () => {
    const subject = `computer-invites-owner-${randomUUID()}`;
    await db.query("INSERT INTO auth.users(id,name,email) VALUES ($1,'Owner',$2)",[subject,`${subject}@relo.example`]);
    await db.query(`INSERT INTO account_identities(principal_id,provider,subject,role,approved_at) VALUES ($1,'better-auth',$2,'owner',now())`,
      [principalId,subject]);
    const made = await call(owner,"POST","/api/clients/computer-invites",{});
    const joined = await call(null,"POST","/api/computer-invites/redeem",{ code: made.body.code,clientName: "Plain box",
      scopes: ["notifications:send"],expiresInSeconds: 86_400,macAppChallenge: "c".repeat(43) });
    expect(joined.status).toBe(200);
    expect(joined.body.desktopAppSignInCode).toBeUndefined();
    expect((await db.query("SELECT count(*)::int AS n FROM mobile_sign_in_codes WHERE principal_id=$1",[principalId])).rows[0].n).toBe(0);
  });

  test("a signed-in computer makes one too; an expired, unknown or malformed code signs nothing in; a phone credential cannot redeem a CLI route",async () => {
    const made = await call(owner,"POST","/api/clients/computer-invites",{});
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ level: "track",approvals: false,agents: null });
    expect((await call(owner,"POST","/api/clients/computer-invites",{ agents: ["Not A Harness"] })).status).toBe(400);
    await db.query("UPDATE computer_invites SET expires_at=now()-interval '1 minute'");
    expect((await redeem(made.body.code)).body.error).toBe("invalid_code");
    expect((await redeem(`rci_${"x".repeat(32)}`)).body.error).toBe("invalid_code");
    expect((await redeem("not-a-code")).status).toBe(400);
    expect((await call(await phone(),"POST","/api/clients/computer-invites",{})).status).toBe(403);
    expect((await db.query("SELECT count(*)::int AS n FROM principal_api_keys WHERE label='Build box'")).rows[0].n).toBe(0);
  });

  test("the Set up checklist ticks from real state: a used login, a phone, a covered agent, a first card",async () => {
    const before = await setupProgress(db,principalId);
    expect(before).toMatchObject({ phone: false,agents: false,firstCard: false });
    const joined = await redeem((await call(owner,"POST","/api/clients/computer-invites",{})).body.code);
    expect((await call(joined.body.accessToken,"GET","/api/clients/self")).status).toBe(200);
    await phone();
    await db.query(`INSERT INTO computers(principal_id,login_key_id,report,reported_at) SELECT principal_id,id,$1,now() FROM principal_api_keys
       WHERE label='Build box' ON CONFLICT (login_key_id) DO UPDATE SET report=EXCLUDED.report,reported_at=now()`,
      [{ harnesses: [{ id: "claude-code",detected: true,level: "guide" },{ id: "codex",detected: true,level: "none" },
        { id: "gemini",detected: false,level: "none" }] }]);
    const after = await setupProgress(db,principalId);
    expect(after).toMatchObject({ computer: true,phone: true,agents: true,firstCard: false });
  });

  const report = { cli: { version: "0.17.40",latest: null,update: "current" },os: { platform: "linux",release: "6.8" },machineKind: "server",
    harnesses: [{ id: "claude-code",detected: true,instructions: "set",level: "guide",modules: [],skill: "current",hooks: "presence",
      hooksOutdated: false,mcp: "none" }],settings: [],profiles: { count: 1,active: "default" },
    doctor: { at: "2026-10-17T10:00:00Z",ok: false,failing: ["phone"] },outbox: { pending: 0 } };

  test("the status of a code is derived at every step, for the owner's phone and browser, and no other account sees it",async () => {
    const credential = await phone();
    const made = await call(credential,"POST","/api/devices/self/computer-invites",{});
    expect(made.body.inviteId).toMatch(/^cin_[0-9a-f-]{36}$/);
    const path = `/api/devices/self/computer-invites/${made.body.inviteId}`;
    const status = async () => {
      const read = await call(credential,"GET",path);
      expect(read.status).toBe(200);
      return computerInviteStatusSchema.parse(read.body);
    };
    expect(await status()).toMatchObject({ inviteId: made.body.inviteId,state: "waiting",computer: null });
    expect((await app.request(path,{ headers: { authorization: `Bearer ${credential}` } })).headers.get("cache-control")).toBe("private, no-store");

    const joined = await redeem(made.body.code,"build-box",joinScopes);
    const cli = joined.body.accessToken as string;
    const redeemed = await status();
    expect(redeemed.state).toBe("redeemed");
    expect(redeemed.computer).toMatchObject({ name: "build-box",cliVersion: null,harnesses: [],check: null });
    expect(redeemed.computer!.clientId).toMatch(/^key_/);
    expect(redeemed.computer).toMatchObject({ identityKey: null,binding: null });
    // A phone registered before the computer joined shows it pending until a device approves its key.
    expect(redeemed.computer?.approval).toBe("waiting");

    const key = createECDH("prime256v1");
    const identityKey = key.generateKeys().toString("base64url");
    const binding = randomBytes(32).toString("base64url");
    expect((await call(cli,"PUT","/api/clients/self/keys",{ identityKey,binding })).status).toBe(200);
    expect((await status()).state).toBe("key_published");
    expect((await status()).computer).toMatchObject({ identityKey,binding });
    // The same key published again, with or without a binding, keeps the stored one; the server never checks it.
    expect((await call(cli,"PUT","/api/clients/self/keys",{ identityKey })).status).toBe(200);
    expect((await call(cli,"PUT","/api/clients/self/keys",{ identityKey,binding: randomBytes(32).toString("base64url") })).status).toBe(200);
    expect((await status()).computer?.binding).toBe(binding);
    expect((await call(cli,"PUT","/api/clients/self/keys",{ identityKey,binding: "short" })).status).toBe(400);
    // A different key replaces the binding with its own (or none).
    const other = createECDH("prime256v1").generateKeys().toString("base64url");
    expect((await call(cli,"PUT","/api/clients/self/keys",{ identityKey: other })).status).toBe(200);
    expect((await status()).computer).toMatchObject({ identityKey: other,binding: null });
    const listed = await listClientKeys(db,principalId);
    expect(listed.find((entry) => entry.publicKey === other)?.binding).toBeNull();
    expect((await call(cli,"PUT","/api/clients/self/keys",{ identityKey,binding })).status).toBe(200);
    expect((await status()).computer).toMatchObject({ identityKey,binding });
    expect((await listClientKeys(db,principalId)).find((entry) => entry.publicKey === identityKey)?.binding).toBe(binding);

    expect((await call(cli,"PUT","/api/computers/self/report",report)).status).toBe(204);
    const reported = await status();
    expect(reported.state).toBe("reported");
    expect(reported.computer).toMatchObject({ cliVersion: "0.17.40",check: { ok: false,failing: ["phone"] },
      harnesses: [{ id: "claude-code",detected: true,level: "guide" }] });

    const approver = (await db.query<{ id: string }>("SELECT id FROM devices WHERE principal_id=$1 LIMIT 1",[principalId])).rows[0]!.id;
    await db.query(`INSERT INTO computer_approvals(api_key_id,principal_id,identity_key,approved_by_device,signed_at,signature)
      VALUES ($1,$2,$3,$4,$5,$6)`,[internalLoginId(reported.computer!.clientId),principalId,identityKey,approver,new Date().toISOString(),"A".repeat(86)]);
    expect((await status()).computer?.approval).toBe("approved");

    expect((await call(cli,"POST","/api/notifications",{ sourceName: "Relo",title: "Relo is set up on this computer",body: "Hello" })).status)
      .toBeLessThan(300);
    expect((await status()).state).toBe("tested");

    // Another account's phone gets the same answer as for an id that does not exist.
    const otherId = (await db.query<{ id: string }>("INSERT INTO owner_principals(handle) VALUES ('other') RETURNING id")).rows[0]!.id;
    const otherPhone = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment) VALUES ($1,$2,$3,'iPhone','com.example.relo.notifications','1','1','26','sandbox')
      RETURNING id`,[otherId,randomUUID(),randomUUID()])).rows[0]!.id;
    const otherToken = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [otherPhone,hashToken(otherToken)]);
    expect(await call(otherToken,"GET",path)).toEqual({ status: 404,body: { error: "not_found" } });
    expect(await call(credential,"GET",`/api/devices/self/computer-invites/cin_${randomUUID()}`)).toEqual({ status: 404,body: { error: "not_found" } });
    expect((await call(credential,"GET","/api/devices/self/computer-invites/nope")).status).toBe(404);
  });

  test("an unredeemed code past its time reads expired",async () => {
    const credential = await phone();
    const made = await call(credential,"POST","/api/devices/self/computer-invites",{});
    await db.query("UPDATE computer_invites SET expires_at=now()-interval '1 minute'");
    expect((await call(credential,"GET",`/api/devices/self/computer-invites/${made.body.inviteId}`)).body.state).toBe("expired");
  });

  test("a redemption, a key, a report and a notification each wake the account's live streams",async () => {
    const listener = await db.connect();
    const hints: string[] = [];
    listener.on("notification",(message) => { if (message.channel === "relo_current_changes") hints.push(message.payload ?? ""); });
    try {
      await listener.query("LISTEN relo_current_changes");
      const made = await call(await phone(),"POST","/api/devices/self/computer-invites",{});
      hints.length = 0;
      const cli = (await redeem(made.body.code,"Build box",joinScopes)).body.accessToken as string;
      await vi.waitFor(() => expect(hints.some((hint) => hint.includes(principalId))).toBe(true),{ timeout: 10_000 });
      hints.length = 0;
      await call(cli,"PUT","/api/clients/self/keys",{ identityKey: createECDH("prime256v1").generateKeys().toString("base64url") });
      await vi.waitFor(() => expect(hints.some((hint) => hint.includes(principalId))).toBe(true),{ timeout: 10_000 });
      hints.length = 0;
      await call(cli,"PUT","/api/computers/self/report",report);
      await vi.waitFor(() => expect(hints.some((hint) => hint.includes(principalId))).toBe(true),{ timeout: 10_000 });
    } finally {
      await listener.query("UNLISTEN relo_current_changes");
      listener.release();
    }
  });
});
