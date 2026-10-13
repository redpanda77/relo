import { z } from "zod";
import type { Database } from "./db.js";
import { QUESTION_CEILING_SECONDS,QUESTION_SECONDS,QuestionWaitTooLongError } from "./question-policy.js";

type Queryable = { query: Database["query"] };

/** How long a question may wait on this server: the admin's setting (ADR 0004 server_settings). */
export async function maxQuestionSeconds(db: Queryable): Promise<number> {
  const result = await db.query<{ max_question_seconds: number }>(
    "SELECT max_question_seconds FROM server_settings WHERE singleton");
  return result.rows[0]?.max_question_seconds ?? 604_800;
}

/** Refuses a question that would wait longer than the server admin allows. */
export async function assertQuestionWait(db: Queryable, seconds: number): Promise<void> {
  if (seconds <= QUESTION_SECONDS) return;
  const maximum = await maxQuestionSeconds(db);
  if (seconds > maximum) throw new QuestionWaitTooLongError(maximum);
}

export async function setMaxQuestionSeconds(db: Database, seconds: number): Promise<void> {
  await db.query("UPDATE server_settings SET max_question_seconds=$1,updated_at=now() WHERE singleton",
    [z.number().int().min(QUESTION_SECONDS).max(QUESTION_CEILING_SECONDS).parse(seconds)]);
}

