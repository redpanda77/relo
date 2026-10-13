import { z } from "zod";
import { choiceOptionsSchema } from "@relo/notification-contracts";

/** By default a question waits five minutes; unanswered, it expires and its card ends. */
export const QUESTION_SECONDS = 300;
/** The longest any server lets a question wait; each server's admin sets its own limit below this. */
export const QUESTION_CEILING_SECONDS = 30*24*60*60;
/** A Live Activity lives at most 8 hours on iOS; a question waiting longer continues in Relo. */
export const CARD_MAX_SECONDS = 8*60*60;

export const questionExpirySchema = z.number().int().min(30)
  .max(QUESTION_CEILING_SECONDS,{ message: "A question waits at most 30 days" })
  .default(QUESTION_SECONDS);

/** Thrown when a question would wait longer than this server's admin allows. */
export class QuestionWaitTooLongError extends Error {
  constructor(readonly maximumSeconds: number) { super("question_wait_too_long"); }
}
export const questionWaitTooLongBody = (error: QuestionWaitTooLongError) => ({
  error: "question_wait_too_long",
  message: `Questions on this server wait at most ${waitLabel(error.maximumSeconds)}.`,
  maximumSeconds: error.maximumSeconds,
});

export function waitLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`;
  return `${Math.round(seconds / 60)} minutes`;
}

/**
 * A question is one line the owner can answer from the Lock Screen: the card's subtitle holds at
 * most 120 characters. Everything else (why, risk, what changes) goes in the detail, shown in Relo.
 */
export const QUESTION_MAX_CHARACTERS = 120;
export const QUESTION_DETAIL_MAX_CHARACTERS = 4_000;

export const questionPromptMessage = `Questions are one line of at most ${QUESTION_MAX_CHARACTERS} characters; put the rest in detail`;
export const questionDetailSchema = z.string().trim().min(1).max(QUESTION_DETAIL_MAX_CHARACTERS,
  { message: `Question detail holds at most ${QUESTION_DETAIL_MAX_CHARACTERS} characters` });

export const QUESTION_TYPES = ["approval","yes-no","yes_no","choice"] as const;
export const questionTypeSchema = z.enum(QUESTION_TYPES,
  { message: "Questions take tappable answers only: approval, yes_no or choice (2-4 options)" })
  .transform((value) => value === "yes-no" ? "yes_no" as const : value);
export { choiceOptionsSchema };

/** A choice carries its options and no Approve/Deny labels; the other types carry no options. */
export function checkQuestionAnswers(input: {
  type: string; options?: unknown[] | undefined; primaryLabel?: unknown; secondaryLabel?: unknown;
},context: z.RefinementCtx): void {
  if (input.type === "choice") {
    if (!input.options) context.addIssue({ code: "custom",path: ["options"],message: "A choice question needs 2-4 options" });
    if (input.primaryLabel !== undefined || input.secondaryLabel !== undefined) {
      context.addIssue({ code: "custom",message: "A choice question labels its options, not primary/secondary buttons" });
    }
  } else if (input.options !== undefined) {
    context.addIssue({ code: "custom",path: ["options"],message: "Options belong to a choice question" });
  }
}
