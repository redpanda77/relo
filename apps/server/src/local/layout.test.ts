import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  childEnvironment, ensureLayout, ensureSecrets, localLayout, SECRET_NAMES, SOCKET_PATH_LIMIT, socketPath, socketPathProblem, socketUrl,
} from "./layout.js";
import { RUNTIME_ROLE_ATTRIBUTES } from "./postgres.js";

describe("local mode layout", () => {
  it("keeps the socket in run/ when it fits, and puts it in a short per-user folder when the root is long", () => {
    const short = localLayout("/Users/someone/.local/share/relo/local", 501, "darwin");
    expect(short.socketDir).toBe(short.run);
    expect(socketPathProblem(short, 8187)).toBeNull();
    const long = localLayout(`/Users/someone/${"deep/".repeat(20)}relo`, 501, "darwin");
    expect(long.socketDir).toBe("/tmp/relo-501");
    expect(socketPathProblem(long, 8187)).toBeNull();
    expect(Buffer.byteLength(socketPath(long, 65535))).toBeLessThanOrEqual(SOCKET_PATH_LIMIT);
    // Inside DATABASE_URL, where the API and the worker find it.
    expect(decodeURIComponent(new URL(socketUrl(long, 8187, "u", "p", "relo")).hostname)).toBe("/tmp/relo-501");
  });

  it.skipIf(process.platform === "win32")("makes the short socket folder owner-only and ours", async () => {
    const { ensureLayout } = await import("./layout.js");
    const { uid } = userInfo();
    const root = await mkdtemp(path.join(tmpdir(), "relo-sock-"));
    const long = localLayout(path.join(root, "x".repeat(90)), uid);
    expect(long.socketDir).toBe(`/tmp/relo-${uid}`);
    await ensureLayout(long);
    expect((await stat(long.socketDir)).mode & 0o077).toBe(0);
    expect((await stat(long.socketDir)).uid).toBe(uid);
  });

  it("makes every secret once, owner-only, and keeps it", async () => {
    const layout = localLayout(await mkdtemp(path.join(tmpdir(), "relo-local-")));
    await ensureLayout(layout);
    const first = await ensureSecrets(layout);
    const second = await ensureSecrets(layout);
    expect(second).toEqual(first);
    for (const name of SECRET_NAMES) {
      expect(first[name].length).toBeGreaterThanOrEqual(32);
      if (process.platform !== "win32") expect((await stat(path.join(layout.secrets, name))).mode & 0o077).toBe(0);
    }
    if (process.platform === "win32") return;
    expect((await stat(layout.secrets)).mode & 0o077).toBe(0);
    expect((await stat(layout.run)).mode & 0o077).toBe(0);
  });

  it("gives the API and the worker one environment, loopback only, APP_URL included", async () => {
    const layout = localLayout("/Users/someone/.local/share/relo/local", 501, "darwin");
    const secrets = Object.fromEntries(SECRET_NAMES.map((name) => [name, `${name}-value-that-is-long-enough-0000`])) as never;
    const env = childEnvironment(layout, { port: 8190, handle: "owner", instance: "inst-abc", release: null }, secrets, { PATH: "/usr/bin" });
    expect(env).toMatchObject({
      HOST: "127.0.0.1", PORT: "8190", APP_URL: "http://127.0.0.1:8190", APNS_MODE: "disabled",
      RELO_CONTENT_RETENTION_HOURS: "10", RELO_LOCAL_INSTANCE: "inst-abc", RELO_WORKER_READY_FILE: path.join(layout.run, "worker-ready"),
    });
    expect(env.DATABASE_URL).toBe(socketUrl(layout, 8190, "relo_runtime", "runtime-password-value-that-is-long-enough-0000", "relo"));
    expect(decodeURIComponent(new URL(env.DATABASE_URL!).hostname)).toBe(layout.run);
  });

  it("grants relo_runtime the same attributes as compose's role bootstrap", async () => {
    const script = await readFile(new URL("../../../../deploy/bootstrap-runtime-role.sh", import.meta.url), "utf8");
    expect(script).toContain(`ALTER ROLE relo_runtime ${RUNTIME_ROLE_ATTRIBUTES} PASSWORD`);
  });
});

describe("local mode port", () => {
  it("skips a port something already listens on", async () => {
    const { createServer } = await import("node:net");
    const { freePort } = await import("./layout.js");
    const first = await freePort(18187);
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(first, "127.0.0.1", resolve));
    try {
      expect(await freePort(first)).toBeGreaterThan(first);
    } finally { busy.close(); }
  });
});

describe("local mode config and port choice", () => {
  const config = (port: number, instance = "mine") => ({ port, handle: "owner", instance, release: null });

  it("reads an old config.json without the new fields, and writes the whole file in place", async () => {
    const { readLocalConfig, writeLocalConfig } = await import("./layout.js");
    const { writeFile } = await import("node:fs/promises");
    const layout = localLayout(await mkdtemp(path.join(tmpdir(), "relo-config-")));
    await ensureLayout(layout);
    await writeFile(layout.config, JSON.stringify({ port: 8187, handle: "owner" }));
    expect(await readLocalConfig(layout)).toEqual({ port: 8187, handle: "owner", instance: "", release: null });
    await writeLocalConfig(layout, { port: 8190, handle: "owner", instance: "i", release: "1.0 (1)" });
    expect(await readLocalConfig(layout)).toEqual({ port: 8190, handle: "owner", instance: "i", release: "1.0 (1)" });
  });

  it("keeps the stored port when it is free, or answers as this install; takes another when someone else holds it", async () => {
    const { createServer } = await import("node:http");
    const { choosePort, freePort } = await import("./layout.js");
    const port = await freePort(18300);
    expect(await choosePort(config(port))).toEqual({ port, changed: false });

    let instance: string | null = "mine";
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(instance === null ? { status: "ok" } : { status: "ok", release: "1", instance }));
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      expect(await choosePort(config(port))).toEqual({ port, changed: false });
      instance = "someone-elses";
      const other = await choosePort(config(port));
      expect(other.changed).toBe(true);
      expect(other.port).toBeGreaterThan(port);
      instance = null;
      expect((await choosePort(config(port))).changed).toBe(true);
    } finally { server.close(); }
  });
});
