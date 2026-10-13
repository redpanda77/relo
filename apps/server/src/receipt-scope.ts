import { createHash } from "node:crypto";

export function requiredReceiptServerOriginHash(origin: string | undefined): string {
  if (!origin) throw new Error("APP_URL must explicitly configure the worker receipt origin");
  return receiptServerOriginHash(origin);
}

/** Hash the configured server origin, never the event conversation/origin key. */
export function receiptServerOriginHash(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("Receipt scope requires an HTTP server origin");
  }
  return createHash("sha256").update(url.origin).digest("hex");
}
