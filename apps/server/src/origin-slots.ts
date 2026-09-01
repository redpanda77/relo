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
  const history = await query.query(
    `SELECT * FROM live_activities
     WHERE principal_id=$1 AND origin_hash=$2
     ORDER BY generation DESC,created_at DESC,id DESC
     FOR UPDATE`,
    [principalId,originHash],
  );
  const rows = history.rows as Row[];
  const latest = rows[0] as (Row & { generation: number | string }) | undefined;
  return {
    active: rows.find((row) => (row as { state?: string }).state === "active"),
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
