import { pathToFileURL } from "node:url";

/**
 * Entry the Windows supervisor runs the API and the worker through (`node child.js <script>`): Windows has no SIGTERM,
 * so a child's graceful stop is a message over its IPC channel. The message runs the SIGTERM handlers the server
 * already registers (drain the API, finish the worker's step), then the process exits as it does on a Mac.
 */
const script = process.argv[2];
if (!script) throw new Error("child.js: no script to run");
process.on("message", (message) => {
  if (message === "relo-shutdown") process.emit("SIGTERM", "SIGTERM");
});
// A supervisor that was killed (no chance to ask) drops the channel: stop as if asked, never linger on the port.
process.on("disconnect", () => process.emit("SIGTERM", "SIGTERM"));
// The channel must not keep a finished server alive.
process.channel?.unref();
await import(pathToFileURL(script).href);
