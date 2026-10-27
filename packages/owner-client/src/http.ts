import { OwnerClientError } from "./errors.js";
import type { FetchLike } from "./types.js";

/** The origin a typed address names: scheme and port kept, https added when absent, anything after the host dropped. */
export function normalizeOrigin(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let url: URL;
  try { url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname || url.username || url.password) return null;
  return url.origin;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  bearer?: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  accept?: string;
  /** Default 10 s; null for a stream (the caller supplies its own idle timeout). */
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

/** One server, one fetch. Every authenticated request goes to this origin and nowhere else. */
export class OwnerHttp {
  constructor(readonly origin: string, private readonly fetchFn: FetchLike, private readonly defaultTimeoutMs = 10_000) {}

  async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const url = new URL(path, this.origin);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { Accept: options.accept ?? "application/json", ...options.headers };
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeoutMs = options.timeoutMs === undefined ? this.defaultTimeoutMs : options.timeoutMs;
    const timer = timeoutMs === null ? undefined : setTimeout(abort, timeoutMs);
    try {
      return await this.fetchFn(url.toString(), {
        method: options.method ?? "GET",
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        redirect: "manual",
        cache: "no-store",
        // A stream outlives this call: the caller's own signal must stay wired to it.
        signal: timeoutMs === null && options.signal ? options.signal : controller.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new OwnerClientError("unreachable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}

/** The status every authenticated read treats alike. */
export function failFor(response: Response, code?: string): OwnerClientError {
  const status = response.status;
  if (status === 401 || status === 403) return new OwnerClientError("unauthorized", status, code);
  if (status === 429) return new OwnerClientError("rate_limited", status, code);
  return new OwnerClientError("unavailable", status, code);
}

export async function readText(response: Response, maxChars: number): Promise<string> {
  const text = await response.text();
  if (text.length > maxChars) throw new OwnerClientError("invalid_response", response.status);
  return text;
}

export async function readJson(response: Response, maxChars = 1_048_576): Promise<unknown> {
  const text = await readText(response, maxChars);
  try { return JSON.parse(text); } catch { throw new OwnerClientError("invalid_response", response.status); }
}

export async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = JSON.parse(await response.text()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch { return undefined; }
}
