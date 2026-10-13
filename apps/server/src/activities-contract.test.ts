import { describe,expect,test } from "vitest";
import {
  activityEndSchema,activityHeartbeatSchema,activityProviderTimestamp,activityStartSchema,
  activityUpdateSchema,activityWaitSchema,boundedPresentationText,
} from "./activities.js";

describe("credential activity contract", () => {
  test("canonicalizes yes-no waits, applies the five-minute expiry default and the 30-day ceiling", () => {
    expect(activityWaitSchema.parse({ type: "yes-no",prompt: "Continue?" })).toEqual({
      type: "yes_no",prompt: "Continue?",expiresInSeconds: 300,
    });
    expect(activityWaitSchema.parse({
      type: "approval",prompt: "Ship release?",expiresInSeconds: 30,
      primaryLabel: "Approve",secondaryLabel: "Deny",
    })).toMatchObject({ type: "approval",expiresInSeconds: 30 });
    expect(activityWaitSchema.safeParse({ type: "text",prompt: "Describe the blocker" }).success).toBe(false);
    expect(activityWaitSchema.safeParse({ type: "yes_no",prompt: "Continue?",expiresInSeconds: 301 }).success).toBe(true);
    expect(activityWaitSchema.safeParse({ type: "yes_no",prompt: "Continue?",expiresInSeconds: 30 * 86_400 + 1 }).success).toBe(false);
  });

  test("rejects overlong Live Activity prompts, text labels, multiline labels, and expiry overflow", () => {
    expect(activityWaitSchema.safeParse({ type: "approval",prompt: "x".repeat(241) }).success).toBe(false);
    expect(activityWaitSchema.safeParse({ type: "text",prompt: "Reply",primaryLabel: "Send" }).success).toBe(false);
    expect(activityWaitSchema.safeParse({
      type: "yes_no",prompt: "Continue?",primaryLabel: "Yes\nnow",
    }).success).toBe(false);
    expect(activityWaitSchema.safeParse({
      type: "text",prompt: "x".repeat(2_001),expiresInSeconds: 301,
    }).success).toBe(false);
  });

  test("accepts only high-priority APNs delivery for activity updates", () => {
    expect(activityUpdateSchema.parse({ status: "Fast",deliveryPriority: 10 }).deliveryPriority).toBe(10);
    expect(activityUpdateSchema.safeParse({ status: "Routine",deliveryPriority: 5 }).success).toBe(false);
    expect(activityUpdateSchema.safeParse({ status: "Invalid",deliveryPriority: 7 }).success).toBe(false);
  });

  test("accepts bounded semantic context patches without requiring progress", () => {
    expect(activityUpdateSchema.parse({
      status: "Investigating",
      context: {
        providerName: "Codex",
        project: "Relo notifications",
        threadName: "Dashboard lifecycle audit",
        taskTitle: "Correct activity lifecycle history",
      },
    })).toMatchObject({
      status: "Investigating",
      context: {
        threadName: "Dashboard lifecycle audit",
        taskTitle: "Correct activity lifecycle history",
      },
    });
    expect(activityUpdateSchema.safeParse({
      context: { threadName: "x".repeat(161) },
    }).success).toBe(false);
  });

  test("keeps semantic task titles wider than the native activity title limit", () => {
    const taskTitle = "x".repeat(160);
    expect(activityUpdateSchema.parse({
      status: "Working",context: { taskTitle },
    }).context?.taskTitle).toBe(taskTitle);
    expect(boundedPresentationText(taskTitle,80)).toBe(`${"x".repeat(79)}…`);
  });

  test("supports unnamed or named manual acquisition and exact provider lifecycle identity", () => {
    const lifecycle = { provider: "codex",runId: "codex-run-123" };
    const origin = { sourceInstance: "codex-install",project: "relo",thread: "thread",channel: "task" };
    expect(activityStartSchema.safeParse({ acquireMode: "ensure",title: "Task",status: "Starting" }).success)
      .toBe(true);
    expect(activityStartSchema.safeParse({ acquireMode: "ensure",key: "manual-run",title: "Task",status: "Starting" }).success)
      .toBe(true);
    expect(activityStartSchema.safeParse({ lifecycle,title: "Task",status: "Starting" }).success).toBe(false);
    expect(activityStartSchema.safeParse({ lifecycle,origin,title: "Task",status: "Starting" }).success).toBe(true);
    expect(activityUpdateSchema.safeParse({ lifecycle }).success).toBe(false);
    expect(activityUpdateSchema.safeParse({ lifecycle,status: "Working" }).success).toBe(true);
    expect(activityEndSchema.safeParse({ lifecycle,status: "Complete" }).success).toBe(true);
    expect(activityHeartbeatSchema.parse({ lifecycle })).toEqual({ lifecycle,leaseAfterSeconds: 3_600 });
    expect(activityHeartbeatSchema.safeParse({ lifecycle,leaseAfterSeconds: 299 }).success).toBe(false);
    expect(activityHeartbeatSchema.safeParse({ lifecycle,leaseAfterSeconds: 14_401 }).success).toBe(false);
  });

  test("keeps observed ActivityKit time independent of operation sequence", () => {
    expect(activityProviderTimestamp({
      created_at: "2026-08-07T12:00:00.900Z",
      updated_at: "2026-08-07T12:00:00.950Z",
      sequence: 0,
    })).toBe(1_786_104_000);
    expect(activityProviderTimestamp({
      created_at: "2026-08-07T12:00:00.900Z",
      updated_at: "2026-08-07T12:00:00.990Z",
      sequence: 3,
    })).toBe(1_786_104_000);
    expect(() => activityProviderTimestamp({ created_at: "invalid",sequence: 0 }))
      .toThrow("invalid durable Live Activity chronology");
  });
});
