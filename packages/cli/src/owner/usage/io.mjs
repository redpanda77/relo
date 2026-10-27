// The real I/O behind `relo usage` (the adapters take it as parameters, so tests swap it and adapters stay off the
// network): an HTTP reader, a program runner and a loopback-only HTTPS poster. Each never throws.
import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { request } from "node:https";

/** HTTP for the plan endpoints: { status, retryAfter, json }; status 0 when the request itself failed. */
export async function fetchJson(url, { method = "GET", headers = {}, body, timeoutMs = 15_000 } = {}) {
  try {
    const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    let json;
    try { json = await response.json(); } catch { json = undefined; }
    return { status: response.status, retryAfter: response.headers.get("retry-after"), json };
  } catch { return { status: 0, retryAfter: null, json: undefined }; }
}


/** Runs a program and resolves its stdout, or "" on any failure . */
export function runProgram(file, args, { timeoutMs = 5000 } = {}) {
  return new Promise((done) => {
    try {
      const child = execFile(file, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8_000_000, windowsHide: true }, (error, stdout) => done(error ? "" : String(stdout)));
      child.stdin?.end();
    } catch { done(""); }
  });
}

/** Starts a program detached from this process (stdio ignored, unref'd so the CLI can exit) and resolves its pid, or null. */
export function spawnDetached(file, args) {
  return new Promise((done) => {
    try {
      const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", () => done(null));
      child.unref();
      // spawn reports a missing or non-executable file asynchronously, as 'error'; a pid means it started.
      setImmediate(() => done(child.pid ?? null));
    } catch { done(null); }
  });
}

/** Whether a path exists. */
export const pathExists = (path) => stat(path).then(() => true, () => false);

/** Resolves after `ms` milliseconds. */
export const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * POSTs to https://127.0.0.1:<port><path> and accepts that address's self-signed certificate (the host is fixed here, so
 * nothing reached over a network is ever trusted). { status, json }; status 0 when the request failed.
 */
export function loopbackPost({ port, path, headers = {}, body = "", timeoutMs = 10_000 }) {
  return new Promise((done) => {
    try {
      const req = request({
        host: "127.0.0.1", port, path, method: "POST", rejectUnauthorized: false, checkServerIdentity: () => undefined, timeout: timeoutMs,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let json;
          try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { json = undefined; }
          done({ status: response.statusCode ?? 0, json });
        });
        response.on("error", () => done({ status: 0, json: undefined }));
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => done({ status: 0, json: undefined }));
      req.end(body);
    } catch { done({ status: 0, json: undefined }); }
  });
}
