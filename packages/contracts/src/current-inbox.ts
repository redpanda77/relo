import { z } from "zod";

const scalarText = (maximum: number) => z.string().refine(value => Array.from(value).length <= maximum);
const date = z.iso.datetime({ offset: true });
export const currentSubjectIdSchema = z.string().regex(/^(sub|ntf|act)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const currentSubjectProjectionSchema = z.object({
  subjectId: currentSubjectIdSchema,
  notificationId: z.string().nullable(),
  kind: z.enum(["notice","decision","progress","incident"]),
  version: z.object({ generation: z.number().int().positive(),revision: z.number().int().positive() }),
  title: scalarText(200),summary: scalarText(240),source: scalarText(200),
  createdAt: date,updatedAt: date,occurredAt: date.nullable(),acceptedAt: date,readAt: date.nullable(),
  // A lifecycle deadline can cap native progress/decision availability separately
  // from its original policy. Freshness alone never makes a subject disappear.
  currentUntil: date.nullable(),freshUntil: date.nullable(),deliverUntil: date,
  freshness: z.enum(["fresh","stale","unknown"]),
  interaction: z.object({ id: z.string(),type: z.enum(["approval","yes_no","text"]),state: z.literal("pending"),expiresAt: date }).nullable(),
  activity: z.object({ id: z.string(),generation: z.number().int().positive(),sequence: z.number().int().nonnegative(),
    status: scalarText(240).nullable(),progress: z.number().min(0).max(1).nullable() }).nullable(),
  resources: z.object({
    source: z.object({ id: z.string(),kind: z.string(),name: scalarText(200) }),
    project: z.object({ id: z.string(),name: scalarText(200),isDirect: z.boolean(),
      palette: z.object({ slot: z.number().int().min(0).max(11),generation: z.number().int().nonnegative() }),
      icon: z.string(),revision: z.number().int().positive() }),
    conversationId: z.string().nullable(),workItemId: z.string().nullable(),
  }).nullable(),
  /** End-to-end sealed text for this phone (opened on the phone; the fields above are placeholders). */
  sealed: z.object({ alert: z.unknown().nullable(),content: z.unknown() }).nullable().optional(),
}).strict();
export const retiredSubjectSchema = z.object({
  subjectId: currentSubjectIdSchema,
  reason: z.enum(["expired","settled","resolved","withdrawn","superseded","ended","not_found"]),
  version: z.object({ generation: z.number().int().positive(),revision: z.number().int().positive() }).optional(),
}).strict();
export const currentInboxResponseSchema = z.object({
  items: z.array(currentSubjectProjectionSchema).max(50),retired: z.array(retiredSubjectSchema).max(50),
  total: z.number().int().nonnegative(),cursor: z.string().nullable(),hasMore: z.boolean(),
  counts: z.object({ actionable: z.number().int().nonnegative(),currentUnread: z.number().int().nonnegative() }),
  nextExpiryAt: date.nullable(),serverTime: date,
}).strict();
export type CurrentSubjectProjection = z.infer<typeof currentSubjectProjectionSchema>;
export type RetiredSubject = z.infer<typeof retiredSubjectSchema>;
export type CurrentInboxResponse = z.infer<typeof currentInboxResponseSchema>;
// Empty subject IDs request full current reconciliation; this is not a replay cursor.
export const currentChangeHintSchema=z.object({
  subjectIds:z.array(currentSubjectIdSchema).max(50),invalidateCounts:z.boolean(),
}).strict();
export type CurrentChangeHint=z.infer<typeof currentChangeHintSchema>;
