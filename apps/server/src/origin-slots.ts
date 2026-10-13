import { createHash } from "node:crypto";
import { originDescriptorSchema,type OriginDescriptor } from "@relo/notification-contracts";

export { originDescriptorSchema,type OriginDescriptor };

export function canonicalOriginHash(principalId: string, input: OriginDescriptor): string {
  const origin = originDescriptorSchema.parse(input);
  const digest = createHash("sha256").update(JSON.stringify([
    "relo-origin-v1",
    principalId,
    origin.sourceInstance,
    origin.project,
    origin.thread,
    origin.channel,
  ])).digest("base64url");
  return `org_${digest}`;
}

export async function lockOriginSlot(
  query: { query: (text: string, values?: unknown[]) => Promise<any> },
  principalId: string,
  originHash: string,
): Promise<void> {
  await query.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",
    [`${principalId}:${originHash}`],
  );
}

export type OriginGenerationSlot<Row = any> = {
  active: Row | undefined;
  latest: Row | undefined;
  nextGeneration: number;
};

export async function lockOriginGenerationSlot<Row = any>(
  query: { query: (text: string, values?: unknown[]) => Promise<any> },
  principalId: string,
  originHash: string,
  afterLock?: () => Promise<void>,
): Promise<OriginGenerationSlot<Row>> {
  await lockOriginSlot(query,principalId,originHash);
  await afterLock?.();
  // The advisory lock serializes allocation. Only current pointers need row
  // locks; archived generations must not grow this immediate path's lock set.
  const current = await query.query(
    `SELECT * FROM live_activities
     WHERE principal_id=$1 AND origin_hash=$2
     ORDER BY generation DESC,created_at DESC,id DESC
     LIMIT 1 FOR UPDATE`,
    [principalId,originHash],
  );
  const latest = current.rows[0] as (Row & { generation: number | string; state: string }) | undefined;
  const active = latest?.state === "active" ? latest : (await query.query(
    `SELECT * FROM live_activities
     WHERE principal_id=$1 AND origin_hash=$2 AND state='active' LIMIT 1 FOR UPDATE`,
    [principalId,originHash],
  )).rows[0] as Row | undefined;
  return {
    active,
    latest,
    nextGeneration: Number(latest?.generation ?? 0)+1,
  };
}

export function originGenerationMetadata(
  row: { generation?: number | string | null;origin_hash?: string | null },
  reused: boolean,
) {
  return {
    reused,
    resumed: !reused && row.origin_hash != null && Number(row.generation ?? 1)>1,
  };
}

export function dashboardTestLabOrigin(principalId: string, deviceId: string): string {
  return canonicalOriginHash(principalId,{
    sourceInstance: "dashboard",
    project: "dashboard",
    thread: `device:${deviceId}`,
    channel: "test-lab-preview",
  });
}
