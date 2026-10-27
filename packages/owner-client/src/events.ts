import { currentChangeHintSchema, type CurrentChangeHint } from "@relo/notification-contracts";
import { OwnerClientError } from "./errors.js";
import type { OwnerHttp } from "./http.js";

const MAX_FRAME_CHARS = 8_192;

/** An SSE frame parser: CRLF, comments and split chunks accepted; a frame over 8 KB is hostile and ends the stream. */
export class SseParser {
  private buffer = "";
  private frameChars = 0;
  private event = "";
  private data: string[] = [];

  push(chunk: string): { event: string; data: string }[] {
    const frames: { event: string; data: string }[] = [];
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.frameChars += line.length + 1;
      if (this.frameChars > MAX_FRAME_CHARS) throw new OwnerClientError("invalid_response");
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (this.event) frames.push({ event: this.event, data: this.data.join("\n") });
        this.event = ""; this.data = []; this.frameChars = 0;
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") this.event = value;
        else if (field === "data") this.data.push(value);
      }
    }
    if (this.buffer.length + this.frameChars > MAX_FRAME_CHARS) throw new OwnerClientError("invalid_response");
    return frames;
  }
}

export const RECONCILE: CurrentChangeHint = { subjectIds: [], invalidateCounts: true };

export interface FollowOptions {
  http: OwnerHttp;
  token: string;
  signal: AbortSignal;
  /** A hint that Now changed (or a reconcile: read everything). Never carries content. */
  onHint(hint: CurrentChangeHint): void;
  onConnected?(): void;
  onFailure?(error: unknown): void;
  /** Aborts a silent stream: the server sends a keepalive every 15 s (current-state-stream.ts). */
  idleTimeoutMs?: number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  random?(): number;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Reconnect delay after `failures` failures: jittered in [ceiling/2, ceiling], ceiling 250 ms doubling to 5 s. */
export function backoffMs(failures: number, random: () => number): number {
  const ceiling = Math.min(5_000, 250 * 2 ** Math.min(failures, 5));
  const floor = Math.max(1, Math.floor(ceiling / 2));
  return floor + Math.floor(random() * (ceiling - floor + 1));
}

/**
 * GET /api/inbox/events (inbox-routes.ts:20, current-state-stream.ts): text/event-stream, device bearer, frames
 * `event: current` + `data: {"subjectIds":[…],"invalidateCounts":true}` (currentChangeHintSchema), `: keepalive` comments.
 * Reconnects with backoff and asks for a full read after every outage. Resolves when `signal` aborts; rejects only
 * when the credential is refused (401/403) or the server's stream is incompatible.
 */
export async function followEvents(options: FollowOptions): Promise<void> {
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const idle = options.idleTimeoutMs ?? 35_000;
  let failures = 0;
  let resync = false;
  // No hint at start: the caller reads Now itself when it starts the feed.
  while (!options.signal.aborted) {
    const connection = new AbortController();
    const stop = () => connection.abort();
    options.signal.addEventListener("abort", stop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(stop, idle); };
    let connectedAt: number | null = null;
    try {
      arm();
      const response = await options.http.request("/api/inbox/events", {
        bearer: options.token, accept: "text/event-stream", timeoutMs: null, signal: connection.signal,
      });
      if (response.status === 401 || response.status === 403) throw new OwnerClientError("unauthorized", response.status);
      if (response.status !== 200 || !response.body) throw new OwnerClientError("unavailable", response.status);
      if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream")) {
        throw new OwnerClientError("invalid_response", response.status);
      }
      connectedAt = Date.now();
      options.onConnected?.();
      if (resync) { resync = false; options.onHint(RECONCILE); }
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (frame.event !== "current") continue;
          const hint = (() => { try { return currentChangeHintSchema.safeParse(JSON.parse(frame.data)); } catch { return null; } })();
          if (!hint?.success) throw new OwnerClientError("invalid_response");
          options.onHint(hint.data);
        }
      }
      throw new OwnerClientError("unavailable"); // EOF: the server closed it; read everything again.
    } catch (error) {
      if (options.signal.aborted) return;
      if (error instanceof OwnerClientError && (error.kind === "unauthorized" || error.kind === "invalid_response")) throw error;
      options.onFailure?.(error);
      if (connectedAt !== null && Date.now() - connectedAt >= 15_000) failures = 0;
      options.onHint(RECONCILE);
      resync = true;
      await sleep(backoffMs(failures, random), options.signal);
      failures = Math.min(failures + 1, 5);
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", stop);
      connection.abort();
    }
  }
}
