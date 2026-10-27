import { connect, createServer, type Server } from "node:net";
import type { Readable } from "node:stream";

/**
 * The supervisor's stop channels where there is no SIGTERM (Windows).
 *  - a named pipe, `\\.\pipe\relo-local-<hash of the data root>` (controlPipeName): a client writes `stop\n`; the pipe
 *    also makes a second supervisor on the same data root fail at once instead of fighting over the database.
 *  - stdin (`--stop-on-stdin-close`): the launcher holds the write end, so closing it, or the launcher dying, stops
 *    the supervisor gracefully rather than leaving it orphaned.
 */
export class AlreadyRunningError extends Error {
  constructor() {
    super("Relo's server is already running for this data folder");
    this.name = "AlreadyRunningError";
  }
}

export type Control = { close: () => Promise<void> };

export function listenForStop(options: {
  pipeName?: string;
  stdin?: Readable | null;
  onStop: (reason: string) => void;
}): Promise<Control> {
  const { pipeName, stdin, onStop } = options;
  return new Promise<Control>((resolve, reject) => {
    const finish = (server?: Server) => {
      if (stdin) {
        stdin.on("end", () => onStop("stdin closed"));
        stdin.on("close", () => onStop("stdin closed"));
        stdin.resume();
      }
      resolve({ close: () => new Promise<void>((done) => server ? server.close(() => done()) : done()) });
    };
    if (!pipeName) return finish();
    const server = createServer((socket) => {
      let received = "";
      socket.setEncoding("utf8");
      socket.on("error", () => undefined);
      socket.on("data", (chunk: string) => {
        received += chunk;
        if (/^stop\s*$/m.test(received)) {
          socket.end("stopping\n");
          onStop("pipe");
        }
      });
    });
    server.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "EADDRINUSE" ? new AlreadyRunningError() : error));
    server.listen(pipeName, () => finish(server));
  });
}

/** Asks the supervisor that owns `pipeName` to stop; false when nothing answers on it. */
export function requestStop(pipeName: string, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(pipeName);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
    socket.once("connect", () => socket.write("stop\n"));
    socket.once("data", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
  });
}
