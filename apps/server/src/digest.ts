import { createHash } from "node:crypto";

/** SHA-256 as lowercase hex: request fingerprints and idempotency hashes. Credentials use credentials/hash.ts. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text,"utf8").digest("hex");
}
