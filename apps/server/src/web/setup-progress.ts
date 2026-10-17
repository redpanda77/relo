import type { Database } from "../db.js";
import { simulatorSql } from "../device-models.js";
import { ownerOverviewSql } from "../owner-overview.js";

/**
 * The Dashboard's Set up checklist: what a new account still has to do, read from real state (never ticked by hand).
 * A computer signed in, an iPhone registered, an agent set up on a computer (its own setup report), a first card or
 * notification. Agents a computer has but Relo does not cover show on that computer in Connections, not here.
 */
export type SetupProgress = {
  computer: boolean; phone: boolean; agents: boolean; firstCard: boolean;
};

type ReportedHarness = { id?: unknown; level?: unknown };

export async function setupProgress(db: Pick<Database,"query">,principalId: string): Promise<SetupProgress> {
  const [facts,reports] = await Promise.all([
    db.query<{ computer: boolean; phone: boolean; first_card: boolean }>(
      `SELECT
         EXISTS (SELECT 1 FROM principal_api_keys k WHERE k.principal_id=$1 AND k.kind='login' AND k.revoked_at IS NULL
           AND (k.expires_at IS NULL OR k.expires_at>now()) AND k.last_used_at IS NOT NULL) AS computer,
         EXISTS (SELECT 1 FROM devices d WHERE d.principal_id=$1 AND d.revoked_at IS NULL
           AND NOT ${simulatorSql("d")} AND NOT ${ownerOverviewSql("d")}) AS phone,
         (EXISTS (SELECT 1 FROM notification_events WHERE principal_id=$1) OR EXISTS (SELECT 1 FROM works WHERE principal_id=$1)) AS first_card`,
      [principalId]),
    db.query<{ report: { harnesses?: ReportedHarness[] } | null }>(
      `SELECT c.report FROM computers c JOIN principal_api_keys k ON k.id=c.login_key_id
       WHERE c.principal_id=$1 AND k.revoked_at IS NULL AND c.report IS NOT NULL ORDER BY c.reported_at DESC LIMIT 32`,
      [principalId]),
  ]);
  const row = facts.rows[0]!;
  let agents = false;
  for (const computer of reports.rows) {
    for (const harness of Array.isArray(computer.report?.harnesses) ? computer.report.harnesses : []) {
      if (typeof harness?.id !== "string" || harness.id === "agents") continue;
      if (typeof harness.level === "string" && harness.level !== "none") agents = true;
    }
  }
  return { computer: row.computer,phone: row.phone,agents,firstCard: row.first_card };
}
