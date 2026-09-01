import { describe,expect,test } from "vitest";
import {
  ApnsOperationError,
  assertPreparedApnsCutover,
  quarantineApnsBacklogForCutover,
  quarantineApnsBacklogForRollback,
  recountApnsBacklog,
} from "./apns-operations.js";

type Audit = {
  operation: "cutover_quarantine" | "rollback_quarantine";
  cutover_at: Date;
  configuration_generation: string;
  counts: Record<string,number>;
};

class FakeOperationsDatabase {
  readonly statements: Array<{ text: string; values?: unknown[] }> = [];
  latest: Audit | undefined;
  processing = 0;
  unsafeDiagnostics = false;
  released = false;

  async query(text: string,values?: unknown[]) {
    this.statements.push({ text,...(values ? { values } : {}) });
    if (text.includes("GROUP BY j.transport")) return {
      rowCount: 1,rows: [{
        transport: "notification",state: "pending",
        error_code: this.unsafeDiagnostics ? "token leaked value" : null,count: 3,before_cutover: 2,
      }],
    };
    if (text.includes("GROUP BY outcome_category")) return {
      rowCount: 1,rows: [{ outcome_category: this.unsafeDiagnostics ? "bad response body" : "accepted",count: 1 }],
    };
    if (text.includes("FROM apns_operation_audit ORDER BY")) {
      return { rowCount: this.latest ? 1 : 0,rows: this.latest ? [this.latest] : [] };
    }
    if (text.includes("count(*)::int AS count FROM delivery_jobs WHERE state='processing'")) {
      return { rowCount: 1,rows: [{ count: this.processing }] };
    }
    if (text.includes("claim_phase='preparing'") && text.includes("state='retry'")) {
      return { rowCount: 1,rows: [] };
    }
    if (text.includes("claim_phase IS DISTINCT FROM 'preparing'")
      && text.includes("abandoned_provider_claim")) return { rowCount: 2,rows: [] };
    if (text.includes("last_error_code='pre_apns_cutover'")) return { rowCount: 3,rows: [] };
    if (text.includes("last_error_code='apns_rollback_quarantine'")) return { rowCount: 4,rows: [] };
    if (text.includes("last_error_code='apns_rollback_pre_dispatch'")) return { rowCount: 1,rows: [] };
    if (text.includes("last_error_code='apns_rollback_dispatch_uncertain'")) return { rowCount: 2,rows: [] };
    if (text.startsWith("INSERT INTO apns_operation_audit")) {
      this.latest = {
        operation: values?.[0] as Audit["operation"],cutover_at: values?.[1] as Date,
        configuration_generation: values?.[2] as string,
        counts: JSON.parse(values?.[3] as string) as Record<string,number>,
      };
      return { rowCount: 1,rows: [] };
    }
    return { rowCount: 1,rows: [] };
  }

  async connect() { return this; }
  release() { this.released = true; }
}

const cutoverAt = new Date("2026-08-07T12:00:00.000Z");

describe("APNs backlog and cutover operations", () => {
  test("recounts only aggregate safe dimensions", async () => {
    const db = new FakeOperationsDatabase();
    await expect(recountApnsBacklog(db as never,cutoverAt)).resolves.toEqual({
      cutoverAt: cutoverAt.toISOString(),
      jobs: [{ transport: "notification",state: "pending",errorCode: null,count: 3,beforeCutover: 2 }],
      attempts: [{ outcome: "accepted",count: 1 }],
    });
    const sql = db.statements.map(({ text }) => text).join("\n");
    expect(sql).not.toMatch(/apns_token|payload|claim_token|provider_message_id/);
    db.unsafeDiagnostics = true;
    await expect(recountApnsBacklog(db as never,cutoverAt)).resolves.toMatchObject({
      jobs: [{ errorCode: null }],attempts: [{ outcome: "unknown" }],
    });
  });

  test("atomically quarantines a stopped pre-cutover backlog and records immutable evidence", async () => {
    const db = new FakeOperationsDatabase();
    const result = await quarantineApnsBacklogForCutover(db as never,cutoverAt,"generation-1");
    expect(result).toEqual({
      operation: "cutover_quarantine",cutoverAt: cutoverAt.toISOString(),
      configurationGeneration: "generation-1",alreadyApplied: false,
      counts: { quarantined: 3,safelyRequeued: 1,reconciliationRequired: 2 },
    });
    expect(db.latest).toMatchObject({ operation: "cutover_quarantine" });
    expect(db.statements.map(({ text }) => text)).toEqual(expect.arrayContaining([
      "BEGIN","COMMIT",expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("last_error_code='pre_apns_cutover'"),
      expect.stringContaining("INSERT INTO apns_operation_audit"),
    ]));
    const second = await quarantineApnsBacklogForCutover(db as never,cutoverAt,"generation-1");
    expect(second.alreadyApplied).toBe(true);
    expect(db.statements.filter(({ text }) => text.includes("last_error_code='pre_apns_cutover'")))
      .toHaveLength(1);
  });

  test("refuses cutover while a worker still owns any processing claim", async () => {
    const db = new FakeOperationsDatabase();
    db.processing = 1;
    await expect(quarantineApnsBacklogForCutover(db as never,cutoverAt,"generation-1"))
      .rejects.toMatchObject({ code: "worker_must_be_stopped" });
    expect(db.statements.at(-1)?.text).toBe("ROLLBACK");
  });

  test("rollback cancels replayable work and reconciles every dispatch-fenced claim", async () => {
    const db = new FakeOperationsDatabase();
    db.latest = {
      operation: "cutover_quarantine",cutover_at: cutoverAt,
      configuration_generation: "generation-1",counts: { quarantined: 3 },
    };
    const result = await quarantineApnsBacklogForRollback(db as never,cutoverAt,"generation-1");
    expect(result.counts).toEqual({
      quarantined: 4,preDispatchCanceled: 1,reconciliationRequired: 2,
    });
    const sql = db.statements.map(({ text }) => text).join("\n");
    expect(sql).toContain("apns_rollback_pre_dispatch");
    expect(sql).toContain("apns_rollback_dispatch_uncertain");
    await expect(assertPreparedApnsCutover(db as never,cutoverAt,"generation-1"))
      .rejects.toBeInstanceOf(ApnsOperationError);
  });
});
