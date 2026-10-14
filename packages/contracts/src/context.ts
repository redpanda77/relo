import { z } from "zod";

/** The bounded semantic context producers attach to notices, questions, cards and works. */
export const safeContextSchema = z
  .object({
    providerName: z.string().trim().min(1).max(80).optional(),
    producerKind: z.enum(["agent", "service", "webhook", "manual"]).optional(),
    computer: z.string().trim().min(1).max(120).optional(),
    account: z.string().trim().min(1).max(40).optional(),
    project: z.string().trim().min(1).max(120).optional(),
    providerThreadId: z.string().trim().min(1).max(200).optional(),
    providerWorkItemId: z.string().trim().min(1).max(200).optional(),
    threadName: z.string().trim().min(1).max(160).optional(),
    taskTitle: z.string().trim().min(1).max(160).optional(),
    threadNameSource: z.enum(["provider", "explicit", "fallback"]).optional(),
    taskTitleSource: z.enum(["provider", "prompt_summary", "explicit", "fallback"]).optional(),
  })
  .strict();
