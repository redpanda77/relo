import { createHash } from "node:crypto";
import type { z } from "zod";

// Opaque pagination cursors: a JSON array (usually led by a version tag) in base64url.
// Each list keeps its own tuple schema; this module owns only the encoding.

const maximumCursorLength = 512;

export function encodeCursor(parts: readonly unknown[]): string {
  return Buffer.from(JSON.stringify(parts),"utf8").toString("base64url");
}

/** Returns the parsed tuple, or undefined for a missing, malformed or foreign cursor. */
export function decodeCursor<Schema extends z.ZodType>(
  value: string | undefined,
  schema: Schema,
): z.infer<Schema> | undefined {
  if (!value || value.length > maximumCursorLength || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(value,"base64url").toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Binds a cursor to the account and device that received it. */
export function actorCursorScope(actor: { principalId: string; deviceId?: string | null | undefined }): string {
  return createHash("sha256").update(JSON.stringify([actor.principalId,actor.deviceId ?? null])).digest("hex");
}
