import { z } from "zod";

/** A question waits for the owner at most five minutes; unanswered, it expires and its card ends. */
export const QUESTION_SECONDS = 300;

export const questionExpirySchema = z.number().int().min(30)
  .max(QUESTION_SECONDS,{ message: "Questions wait at most 5 minutes (300 seconds)" })
  .default(QUESTION_SECONDS);
