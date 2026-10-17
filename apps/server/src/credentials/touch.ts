import type { Database } from "../db.js";
import { CREDENTIAL_KIND_TABLE } from "./kinds.js";

type Queryable = Pick<Database,"query">;

/**
 * Last use, for every credential kind (plan 10 B2): at most one write per credential every few minutes, so a busy
 * login does not write on every request. Per process: several server processes may each write once, which is
 * harmless. Only credentials/ writes last_used_at (credentials-reachability.test.ts).
 */
export const TOUCH_INTERVAL_MS = 5 * 60_000;
const TABLES = {
  login: CREDENTIAL_KIND_TABLE.login.table,
  device: CREDENTIAL_KIND_TABLE.device.table,
  harness: CREDENTIAL_KIND_TABLE.harness.table,
  service: CREDENTIAL_KIND_TABLE.service.table,
} as const;
export type TouchedKind = keyof typeof TABLES;

const lastWrite = new Map<string,number>();
const MAX_TRACKED = 10_000;

export async function touch(db: Queryable,kind: TouchedKind,id: string,now = Date.now()): Promise<boolean> {
  const key = `${kind}:${id}`;
  const last = lastWrite.get(key);
  if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return false;
  if (lastWrite.size >= MAX_TRACKED) lastWrite.clear();
  lastWrite.set(key,now);
  await db.query(`UPDATE ${TABLES[kind]} SET last_used_at=now() WHERE id=$1`,[id]);
  return true;
}

/** Tests start from a clean slate. */
export function forgetTouches(): void {
  lastWrite.clear();
}
