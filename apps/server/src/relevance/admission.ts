import { z } from "zod";
import { relevancePolicySchema } from "@relo/notification-contracts";
import { independentSubjectKey, type SubjectCommand } from "./commands.js";

// Authority is filled by the authenticated adapter, never accepted in this input.
export const noticeSubjectCommandSchema = z.object({
  subjectKey: z.string().trim().min(1).max(200),
  generation: z.number().int().positive(),
  revision: z.number().int().positive(),
  operation: z.enum(["update", "replace"]),
  occurredAt: z.iso.datetime({ offset: true }),
  policy: relevancePolicySchema.refine(policy => policy.kind === "notice", {
    message: "Ordinary notifications require a notice policy",
  }),
}).strict();

/** Noninteractive producer state. Resolution is explicit and only meaningful for
 * incidents; progress remains silent and decisions keep their separate authority. */
export const notificationSubjectCommandSchema = noticeSubjectCommandSchema.extend({
  policy: relevancePolicySchema.refine(policy => policy.kind !== "decision", {
    message: "Notifications require a notice, progress or incident policy",
  }),
  status: z.literal("resolved").optional(),
}).superRefine((command,context) => {
  if (command.status !== undefined && command.policy.kind !== "incident") {
    context.addIssue({ code: "custom",path: ["status"],message: "Only incidents can resolve" });
  }
});

export function noticeSubjectCommand(
  explicit: z.infer<typeof noticeSubjectCommandSchema> | undefined,
  idempotencyKey: string,
  createdAt: Date | string,
): SubjectCommand {
  return explicit ?? {
    subjectKey: independentSubjectKey(idempotencyKey), generation: 1, revision: 1,
    operation: "replace", occurredAt: new Date(createdAt).toISOString(), policy: { kind: "notice" },
  };
}

export const decisionSubjectCommandSchema = noticeSubjectCommandSchema.extend({
  policy: relevancePolicySchema.refine(policy => policy.kind === "decision", {
    message: "Interactions require a decision policy",
  }),
});

export function decisionSubjectCommand(
  explicit: z.infer<typeof decisionSubjectCommandSchema> | undefined,
  idempotencyKey: string, createdAt: Date | string, actionSeconds: number,
): SubjectCommand {
  return explicit ? { ...explicit,policy: { kind: "decision",actionSeconds,
    ...(explicit.policy.deliverySeconds === undefined ? {} : { deliverySeconds: explicit.policy.deliverySeconds }) } } : {
    subjectKey: independentSubjectKey(idempotencyKey),generation: 1,revision: 1,
    operation: "replace",occurredAt: new Date(createdAt).toISOString(),policy: { kind: "decision",actionSeconds },
  };
}
