import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AlreadyRunningError, listenForStop, requestStop } from "./control.js";
import {
  childEnvironment, controlPipeName, databasePort, defaultDataRoot, executable, localLayout, readLocalConfig, SECRET_NAMES, socketPathProblem,
  socketUrl, windowsBaseEnvironment,
} from "./layout.js";
import { localComputerName } from "./owner.js";
import { assertNotElevated, chooseDatabasePort, ElevatedError, isElevated, livePostmaster, localConfiguration, startArguments } from "./postgres.js";
import { createShutdown } from "./shutdown.js";

const root = "C:\\Users\\Ana\\AppData\\Local\\Relo\\server";
const windowsLayout = () => localLayout(root, 0, "win32");
const secrets = Object.fromEntries(SECRET_NAMES.map((name) => [name, `${name}-value-that-is-long-enough-0000`])) as never;

describe("Windows local mode: layout", () => {
  it("reaches PostgreSQL over loopback TCP on its own port, never a socket", () => {
    const layout = windowsLayout();
    expect(layout.transport).toBe("tcp");
    expect(layout.db).toBe(`${root}\\db`);
    expect(socketPathProblem(layout, 8187)).toBeNull();
    expect(socketUrl(layout, 8188, "relo", "p w", "relo")).toBe("postgresql://relo:p%20w@127.0.0.1:8188/relo");
    expect(databasePort(layout, { port: 8187, handle: "owner", instance: "i", release: null })).toBe(8188);
    expect(databasePort(layout, { port: 8187, handle: "owner", instance: "i", release: null, dbPort: 9000 })).toBe(9000);
    // The Mac keeps the socket named after the API's port.
    expect(databasePort(localLayout("/x", 1, "darwin"), { port: 8187, handle: "owner", instance: "i", release: null, dbPort: 9000 })).toBe(8187);
  });

  it("defaults the data root to %LOCALAPPDATA%\\Relo\\server, and has none elsewhere", () => {
    expect(defaultDataRoot({ LOCALAPPDATA: "C:\\Users\\Ana\\AppData\\Local" }, "win32")).toBe(root);
    expect(defaultDataRoot({ USERPROFILE: "C:\\Users\\Ana" }, "win32")).toBe(root);
    expect(defaultDataRoot({}, "win32")).toBeNull();
    expect(defaultDataRoot({ LOCALAPPDATA: "x" }, "darwin")).toBeNull();
  });

  it("names the executables with .exe on Windows only", () => {
    expect(executable("C:\\pg\\bin", "pg_ctl", "win32")).toBe("C:\\pg\\bin\\pg_ctl.exe");
    expect(executable("/pg/bin", "pg_ctl", "linux")).toBe(path.join("/pg/bin", "pg_ctl"));
  });

  it("gives the children what Node and PostgreSQL need on Windows, and the database URL on loopback", () => {
    const base = { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\Ana", TEMP: "C:\\Users\\Ana\\AppData\\Local\\Temp", Path: "C:\\Windows\\System32", SECRET_TOKEN: "no" };
    const env = childEnvironment(windowsLayout(), { port: 8187, handle: "owner", instance: "inst", release: null }, secrets, base);
    expect(env).toMatchObject({
      SystemRoot: "C:\\Windows", USERPROFILE: base.USERPROFILE, TEMP: base.TEMP, PATH: "C:\\Windows\\System32", HOST: "127.0.0.1", PORT: "8187",
      DATABASE_URL: "postgresql://relo_runtime:runtime-password-value-that-is-long-enough-0000@127.0.0.1:8188/relo",
    });
    expect(env).not.toHaveProperty("HOME");
    expect(env).not.toHaveProperty("SECRET_TOKEN");
    expect(windowsBaseEnvironment({}).PATH).toBe("C:\\Windows\\System32");
  });

  it("reads and keeps dbPort in config.json, ignoring a bad one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "relo-win-"));
    const layout = { ...localLayout(dir), config: path.join(dir, "config.json") };
    await writeFile(layout.config, JSON.stringify({ port: 8187, handle: "owner", dbPort: 8190 }));
    expect((await readLocalConfig(layout)).dbPort).toBe(8190);
    await writeFile(layout.config, JSON.stringify({ port: 8187, handle: "owner", dbPort: "x" }));
    expect(await readLocalConfig(layout)).not.toHaveProperty("dbPort");
  });

  it("derives one pipe name per data root, case and slash insensitive (the Rust launcher computes the same)", () => {
    expect(controlPipeName(root)).toMatch(/^\\\\\.\\pipe\\relo-local-[0-9a-f]{16}$/);
    expect(controlPipeName(root.toLowerCase() + "\\")).toBe(controlPipeName(root));
    expect(controlPipeName(`${root}2`)).not.toBe(controlPipeName(root));
    // Pinned in apps/windows/server-launcher/src/main.rs too.
    expect(controlPipeName("C:\\Users\\Ana\\AppData\\Local\\Relo\\server")).toBe("\\\\.\\pipe\\relo-local-" + "560219c1557fd329");
  });

  it("calls the local computer This PC on Windows", () => {
    expect(localComputerName("win32")).toBe("This PC");
    expect(localComputerName("darwin")).toBe("This Mac");
  });
});

describe("Windows local mode: PostgreSQL", () => {
  it("starts on loopback with its own port, and keeps the POSIX socket arguments unchanged", () => {
    const args = startArguments(windowsLayout(), 8188);
    expect(args).toEqual(["-D", `${root}\\db`, "-l", path.join(`${root}\\logs`, "postgres.log"), "-w", "-t", "60", "-o", "-p 8188 -c listen_addresses=127.0.0.1", "start"]);
    const posix = startArguments(localLayout("/Users/a/relo", 1, "darwin"), 8187);
    expect(posix[posix.indexOf("-o") + 1]).toBe(`-k '${localLayout("/Users/a/relo", 1, "darwin").socketDir}' -p 8187`);
    expect(localConfiguration(windowsLayout())).toContain("listen_addresses = '127.0.0.1'");
    expect(localConfiguration(windowsLayout())).not.toContain("unix_socket");
    expect(localConfiguration(localLayout("/x", 1, "darwin"))).toContain("unix_socket_permissions = 0700");
  });

  it("refuses an elevated token with a clear message, and only on Windows", async () => {
    const elevated = async () => '"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288","Mandatory group, Enabled by default, Enabled group"';
    const normal = async () => '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192","Mandatory group"';
    expect(await isElevated("win32", elevated)).toBe(true);
    expect(await isElevated("win32", normal)).toBe(false);
    expect(await isElevated("darwin", elevated)).toBe(false);
    await expect(assertNotElevated("win32", elevated)).rejects.toThrow(ElevatedError);
    await expect(assertNotElevated("win32", elevated)).rejects.toThrow(/administrator/);
    await expect(assertNotElevated("win32", normal)).resolves.toBeUndefined();
  });

  it("adopts a PostgreSQL that outlived its supervisor, on the port it has", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "relo-adopt-"));
    const layout = { ...localLayout(dir, 0, "win32"), db: dir };
    const config = { port: 8187, handle: "owner", instance: "i", release: null, dbPort: 8188 };
    const free = async () => true;
    expect(await chooseDatabasePort(layout, config, () => true, free)).toBe(8188);
    await writeFile(path.join(dir, "postmaster.pid"), "4242\r\nC:/data\r\n1700000000\r\n8200\r\n\r\n127.0.0.1\r\n");
    expect(await livePostmaster(layout, (pid) => pid === 4242)).toEqual({ pid: 4242, port: 8200 });
    expect(await chooseDatabasePort(layout, config, (pid) => pid === 4242, free)).toBe(8200);
    // A stale file (its process is gone) is ignored; a held stored port moves to the next free one.
    expect(await chooseDatabasePort(layout, config, () => false, async (port) => port !== 8188)).toBe(8189);
    expect(await chooseDatabasePort(layout, { ...config, dbPort: 8187 }, () => false, free)).toBe(8188);
  });
});

describe("Windows local mode: stop channels", () => {
  const pipe = process.platform === "win32" ? `\\\\.\\pipe\\relo-test-${process.pid}-${Date.now()}` : path.join(tmpdir(), `relo-test-${process.pid}.sock`);

  it("stops on a pipe request, refuses a second supervisor on the same pipe, and stops when stdin closes", async () => {
    const reasons: string[] = [];
    const first = await listenForStop({ pipeName: pipe, onStop: (reason) => reasons.push(reason) });
    await expect(listenForStop({ pipeName: pipe, onStop: () => undefined })).rejects.toThrow(AlreadyRunningError);
    expect(await requestStop(pipe)).toBe(true);
    expect(reasons).toEqual(["pipe"]);
    await first.close();
    expect(await requestStop(pipe, 500)).toBe(false);

    const stdin = new PassThrough();
    const watching = await listenForStop({ stdin, onStop: (reason) => reasons.push(reason) });
    stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reasons[1]).toBe("stdin closed");
    await watching.close();
  });

  it("asks children to stop with the supplied channel instead of SIGTERM", async () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null, kill: () => true });
    const asked: string[] = [];
    const { shutdown } = createShutdown({
      children: () => [child as never], log: () => undefined, stopPostgres: async () => undefined, cleanup: async () => undefined,
      exit: () => undefined,
      terminate: () => { asked.push("ipc"); setImmediate(() => child.emit("exit", 0, null)); },
    });
    await shutdown("pipe");
    expect(asked).toEqual(["ipc"]);
  });
});
