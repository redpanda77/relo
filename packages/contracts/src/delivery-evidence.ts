import { z } from "zod";

const evidenceIdentifierSchema = z.string().regex(/^[a-z]+_[A-Za-z0-9_-]{12,}$/u);
const evidenceTimestampSchema = z.iso.datetime({ offset: true });

export const DELIVERY_EVIDENCE_VERSION = 1 as const;

export const DELIVERY_EVIDENCE_STAGES = [
  "accepted",
  "canonicalized",
  "queued",
  "attempted",
  "provider_accepted",
  "provider_rejected",
  "provider_ambiguous",
  "device_applied",
  "device_received",
  "opened",
  "responded",
  "withdrawn",
  "reconciled",
] as const;

export const DELIVERY_EVIDENCE_STAGE_ORDER = Object.freeze(
  Object.fromEntries(DELIVERY_EVIDENCE_STAGES.map((stage,index) => [stage,(index + 1) * 10])) as
    Record<typeof DELIVERY_EVIDENCE_STAGES[number],number>,
);

export const deliveryEvidenceStageSchema = z.enum(DELIVERY_EVIDENCE_STAGES);
export type DeliveryEvidenceStage = z.infer<typeof deliveryEvidenceStageSchema>;

const safeCodeSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u);
const shortHashSchema = z.string().regex(/^sha256:[a-f0-9]{12}$/u);

export const deliveryEvidenceItemSchema = z.object({
  id: z.string().regex(/^evd_[a-z_]+_[A-Za-z0-9-]{12,}$/u),
  notificationId: evidenceIdentifierSchema,
  deliveryId: evidenceIdentifierSchema.nullable(),
  attemptId: z.string().regex(/^att_[A-Za-z0-9-]{12,}$/u).nullable(),
  deviceId: evidenceIdentifierSchema.nullable(),
  activityId: evidenceIdentifierSchema.nullable(),
  stage: deliveryEvidenceStageSchema,
  stageOrder: z.number().int().positive(),
  state: z.enum([
    "recorded","accepted","rejected","ambiguous","applied","received","opened",
    "responded","withdrawn","reconciled",
  ]),
  detailCode: safeCodeSchema.nullable(),
  serialization: z.object({
    canonicalIntent: shortHashSchema.nullable(),
    deviceProjection: shortHashSchema.nullable(),
    providerBytes: shortHashSchema.nullable(),
  }).strict().nullable(),
  occurredAt: evidenceTimestampSchema,
}).strict();

export const deliveryEvidenceResponseSchema = z.object({
  version: z.literal(DELIVERY_EVIDENCE_VERSION),
  order: z.literal("newest_first"),
  items: z.array(deliveryEvidenceItemSchema),
  cursor: z.string().nullable(),
  hasMore: z.boolean(),
}).strict();

export const deliveryEvidenceMetricsSchema = z.object({
  version: z.literal(DELIVERY_EVIDENCE_VERSION),
  generatedAt: evidenceTimestampSchema,
  queue: z.object({
    pendingJobs: z.number().int().nonnegative(),
    oldestAgeMs: z.number().int().nonnegative().nullable(),
  }).strict(),
  worker: z.object({
    lagMs: z.number().int().nonnegative().nullable(),
  }).strict(),
  delivery: z.object({
    retryRate1h: z.number().min(0).max(1),
    ambiguousOutcomes1h: z.number().int().nonnegative(),
    invalidatedTokens24h: z.number().int().nonnegative(),
    receiptLatencyP95Ms24h: z.number().int().nonnegative().nullable(),
  }).strict(),
}).strict();

export type DeliveryEvidenceItem = z.infer<typeof deliveryEvidenceItemSchema>;
export type DeliveryEvidenceResponse = z.infer<typeof deliveryEvidenceResponseSchema>;
export type DeliveryEvidenceMetrics = z.infer<typeof deliveryEvidenceMetricsSchema>;
