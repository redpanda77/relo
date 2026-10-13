/**
 * Test fixtures predate mandatory work identity. Every real producer must send a project and a
 * topic; fixture create requests that omit them receive this fixture hierarchy instead, so each
 * suite keeps testing its own behavior. Enforcement itself is tested with the opt-out header.
 */
export const TEST_WORK_CONTEXT = { project: "Relo tests", threadName: "Fixture topic" } as const;
export const RAW_WORK_IDENTITY_HEADER = "x-relo-test-raw-identity";

const createPaths = [
  /^\/api\/notifications$/,
  /^\/api\/interactions$/,
  /^\/api\/live-activities$/,
  /^\/hooks\/hook_[A-Za-z0-9_-]{43}$/,
  /^\/hooks\/hook_[A-Za-z0-9_-]{43}\/live-activities$/,
  /^\/hooks(\/live-activities)?$/,
];

function withFixtureIdentity(path: string, init: RequestInit | undefined): RequestInit | undefined {
  if (!init || (init.method ?? "GET").toUpperCase() !== "POST" || typeof init.body !== "string") return init;
  const headers = new Headers(init.headers);
  if (headers.has(RAW_WORK_IDENTITY_HEADER)) {
    headers.delete(RAW_WORK_IDENTITY_HEADER);
    return { ...init, headers };
  }
  const pathname = path.startsWith("http") ? new URL(path).pathname : path.split("?")[0] ?? path;
  if (!createPaths.some((pattern) => pattern.test(pathname))) return init;
  let body: unknown;
  try { body = JSON.parse(init.body); } catch { return init; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return init;
  const record = body as Record<string, unknown>;
  if (record.origin !== undefined) return init;
  const context = (record.context ?? {}) as Record<string, unknown>;
  if (context.project && context.threadName) return init;
  return { ...init, body: JSON.stringify({ ...record, context: { ...TEST_WORK_CONTEXT, ...context } }) };
}

// Hono's app.request builds a standard Request from the path and init; intercept that construction.
const NativeRequest = globalThis.Request;
class FixtureRequest extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const path = typeof input === "string" ? input : input instanceof URL ? input.toString() : null;
    super(input, path ? withFixtureIdentity(path, init) : init);
  }
}
globalThis.Request = FixtureRequest as typeof Request;
