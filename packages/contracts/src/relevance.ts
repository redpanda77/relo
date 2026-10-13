import { z } from "zod";

// These are product lifetimes, independent of APNs storage and history retention.
export const RELEVANCE_DEFAULTS = Object.freeze({
  noticeSeconds: 900, noticeDeliverySeconds: 60, decisionSeconds: 900,
  progressDeliverySeconds: 15, terminalCleanupSeconds: 3_600,
  producerClockToleranceMilliseconds: 1_000,
});
const timestamp = z.iso.datetime({ offset: true });
const seconds = z.number().int().positive();
const scopePart = z.string().min(1).max(200);
export const subjectActorSchema = z.object({ accountId: scopePart, sourceId: scopePart }).strict();
export const subjectVersionSchema = subjectActorSchema.extend({
  subjectKey: scopePart,
  generation: z.number().int().positive(),
  revision: z.number().int().positive(),
}).strict();
export type SubjectActor = z.infer<typeof subjectActorSchema>;
export type SubjectVersion = z.infer<typeof subjectVersionSchema>;

export const relevancePolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("notice"), relevanceSeconds: seconds.optional(), deliverySeconds: seconds.optional() }).strict(),
  z.object({ kind: z.literal("decision"), actionSeconds: seconds.optional(), deliverySeconds: seconds.optional() }).strict(),
  z.object({
    kind: z.literal("progress"), deliverySeconds: seconds.optional(),
    heartbeat: z.object({ intervalSeconds: seconds, lastHeartbeatAt: timestamp }).strict().optional(),
  }).strict(),
  z.object({
    kind: z.literal("incident"), mode: z.enum(["until_resolved", "lease"]),
    leaseUntil: timestamp.optional(), deliverySeconds: seconds.optional(),
  }).strict(),
]).superRefine((policy, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (policy.kind === "notice" && (policy.deliverySeconds ?? Math.min(60, policy.relevanceSeconds ?? 900)) > (policy.relevanceSeconds ?? 900)) issue("Delivery cannot outlive relevance");
  if (policy.kind === "decision" && (policy.deliverySeconds ?? policy.actionSeconds ?? 900) > (policy.actionSeconds ?? 900)) issue("Delivery cannot outlive action validity");
  if (policy.kind === "incident" && (policy.mode === "lease") !== (policy.leaseUntil !== undefined)) issue("Only leased incidents require leaseUntil");
});
export type RelevancePolicy = z.infer<typeof relevancePolicySchema>;

export const relevanceDeadlinesSchema = z.object({
  kind: z.enum(["notice", "decision", "progress", "incident"]),
  occurredAt: timestamp, acceptedAt: timestamp,
  freshUntil: timestamp.nullable(), relevantUntil: timestamp.nullable(),
  actionExpiresAt: timestamp.nullable(), deliverUntil: timestamp,
}).strict().superRefine((value, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (Date.parse(value.occurredAt) > Date.parse(value.acceptedAt) + RELEVANCE_DEFAULTS.producerClockToleranceMilliseconds) issue("Occurrence exceeds future clock tolerance");
  if ((value.kind === "decision") !== (value.actionExpiresAt !== null)) issue("Only decisions have action expiry");
  if (value.kind === "notice" && value.relevantUntil === null) issue("Notices require finite relevance");
  if (value.kind !== "progress" && value.freshUntil !== null) issue("Only declared progress heartbeats have freshness deadlines");
  if ((value.kind === "progress" || value.kind === "decision") && value.relevantUntil !== null) issue("Progress and decisions use their own lifetime rules");
  const end = value.actionExpiresAt ?? value.relevantUntil;
  if (end && Date.parse(value.deliverUntil) > Date.parse(end)) issue("Delivery cannot outlive usefulness");
});
export type RelevanceDeadlines = z.infer<typeof relevanceDeadlinesSchema>;
export const relevanceItemSchema = z.object({
  identity: subjectVersionSchema, deadlines: relevanceDeadlinesSchema,
  status: z.enum(["active", "settled", "resolved"]),
  supersededAt: timestamp.nullable(), supersededBy: subjectVersionSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if ((value.supersededAt === null) !== (value.supersededBy === null)) issue("Supersession requires time and replacement identity");
  if (value.supersededBy && (!sameSubject(value.identity, value.supersededBy) || compareVersion(value.supersededBy, value.identity) <= 0)) issue("Replacement must be a newer version of the same owned subject");
  if (value.status === "settled" && value.deadlines.kind !== "decision") issue("Only decisions settle");
  if (value.status === "resolved" && value.deadlines.kind !== "incident") issue("Only incidents resolve");
});
export type RelevanceItem = z.infer<typeof relevanceItemSchema>;
export const relevanceEvaluationSchema = z.object({
  placement: z.enum(["current", "history"]),
  freshness: z.enum(["fresh", "stale", "unknown"]),
  action: z.enum(["available", "unverified", "expired", "superseded", "settled", "none"]),
  deliveryEligible: z.boolean(),
  alertEligible: z.boolean(),
  alertReason: z.enum(["eligible", "silent_progress", "superseded", "settled", "resolved", "expired", "delivery_expired", "stale", "unverified"]),
}).strict();
export type RelevanceEvaluation = z.infer<typeof relevanceEvaluationSchema>;

function at(value: string): number { return Date.parse(timestamp.parse(value)); }
function plus(value: string, duration: number): string {
  const result = new Date(at(value) + duration * 1_000);
  if (!Number.isFinite(result.getTime())) throw new Error("Lifetime exceeds supported date range");
  return timestamp.parse(result.toISOString());
}

/** Admission only: pass the immutable ORIGINAL occurrence, never retry time. Persist the result once. */
export function normalizeRelevancePolicy(input: RelevancePolicy, occurredAt: string, acceptedAt: string): RelevanceDeadlines {
  const policy = relevancePolicySchema.parse(input);
  if (at(occurredAt) > at(acceptedAt) + RELEVANCE_DEFAULTS.producerClockToleranceMilliseconds) throw new Error("Occurrence exceeds future clock tolerance");
  // Keep original producer evidence, but never extend a lifetime using its clock lead.
  // The resulting deadlines are persisted once; replay never normalizes them again.
  const deadlineOrigin = at(occurredAt) > at(acceptedAt) ? acceptedAt : occurredAt;
  const result: RelevanceDeadlines = {
    kind: policy.kind, occurredAt, acceptedAt, freshUntil: null,
    relevantUntil: null, actionExpiresAt: null, deliverUntil: occurredAt,
  };
  switch (policy.kind) {
    case "notice": {
      const lifetime = policy.relevanceSeconds ?? RELEVANCE_DEFAULTS.noticeSeconds;
      result.relevantUntil = plus(deadlineOrigin, lifetime);
      result.deliverUntil = plus(deadlineOrigin, policy.deliverySeconds ?? Math.min(lifetime, RELEVANCE_DEFAULTS.noticeDeliverySeconds));
      break;
    }
    case "decision": {
      const lifetime = policy.actionSeconds ?? RELEVANCE_DEFAULTS.decisionSeconds;
      result.actionExpiresAt = plus(deadlineOrigin, lifetime);
      result.deliverUntil = plus(deadlineOrigin, policy.deliverySeconds ?? lifetime);
      break;
    }
    case "progress":
      result.deliverUntil = plus(deadlineOrigin, policy.deliverySeconds ?? RELEVANCE_DEFAULTS.progressDeliverySeconds);
      if (policy.heartbeat) {
        if (at(policy.heartbeat.lastHeartbeatAt) > at(acceptedAt) + RELEVANCE_DEFAULTS.producerClockToleranceMilliseconds) throw new Error("Heartbeat exceeds future clock tolerance");
        const heartbeatOrigin = at(policy.heartbeat.lastHeartbeatAt) > at(acceptedAt) ? acceptedAt : policy.heartbeat.lastHeartbeatAt;
        result.freshUntil = plus(heartbeatOrigin, 3 * policy.heartbeat.intervalSeconds);
      }
      break;
    case "incident":
      result.relevantUntil = policy.leaseUntil ?? null;
      result.deliverUntil = plus(deadlineOrigin, policy.deliverySeconds ?? RELEVANCE_DEFAULTS.noticeDeliverySeconds);
      if (result.relevantUntil && at(result.relevantUntil) < at(result.deliverUntil)) result.deliverUntil = result.relevantUntil;
      break;
  }
  return relevanceDeadlinesSchema.parse(result);
}

function sameSubject(a: SubjectVersion, b: SubjectVersion): boolean {
  return a.accountId === b.accountId && a.sourceId === b.sourceId && a.subjectKey === b.subjectKey;
}
function compareVersion(a: SubjectVersion, b: SubjectVersion): number {
  return a.generation === b.generation ? Math.sign(a.revision - b.revision) : Math.sign(a.generation - b.generation);
}

/** `current` is an authoritative pointer for this exact subject, not the newest project notification.
 * With an uncertain clock, `now` must be a persisted lower bound on server time. It may retire
 * known-expired state but cannot establish that an action remains valid. */
export function evaluateRelevance(item: RelevanceItem, now: string, clockTrusted: boolean, current: SubjectVersion | null): RelevanceEvaluation {
  const time = at(now);
  const expired = (deadline: string | null) => deadline !== null && time >= at(deadline);
  const replaced = item.supersededBy !== null || (current !== null && sameSubject(item.identity, current) && compareVersion(current, item.identity) > 0);
  const verified = current !== null && sameSubject(item.identity, current) && compareVersion(current, item.identity) === 0;
  const decision = item.deadlines.kind === "decision";
  const ended = expired(item.deadlines.actionExpiresAt ?? item.deadlines.relevantUntil);
  const freshness = item.deadlines.freshUntil === null ? "unknown" : expired(item.deadlines.freshUntil) ? "stale" : clockTrusted ? "fresh" : "unknown";
  const action = !decision ? "none" : item.status === "settled" ? "settled" : replaced ? "superseded" : ended ? "expired" : !verified || !clockTrusted ? "unverified" : "available";
  const placement = replaced || !verified || ended || item.status !== "active" ? "history" : "current";
  const alertReason = replaced ? "superseded" : item.status === "settled" ? "settled" : item.status === "resolved" ? "resolved" : ended ? "expired" : !verified || !clockTrusted ? "unverified" : expired(item.deadlines.deliverUntil) ? "delivery_expired" : freshness === "stale" ? "stale" : "eligible";
  const deliveryEligible = alertReason === "eligible";
  const silentProgress = deliveryEligible && item.deadlines.kind === "progress";
  return { placement, freshness, action, deliveryEligible, alertEligible: deliveryEligible && !silentProgress, alertReason: silentProgress ? "silent_progress" : alertReason };
}

export type SubjectMutationResult = "advance" | "duplicate" | "stale" | "unauthorized" | "wrong_subject" | "requires_replace" | "invalid_generation";
/** Pure ordering guard; callers must lock the canonical pointer and authenticate actor independently.
 * Only explicit replace opens the next generation. Progress/completion can never do so. */
export function classifySubjectMutation(actor: SubjectActor, candidate: SubjectVersion, current: SubjectVersion | null, operation: "update" | "replace"): SubjectMutationResult {
  subjectActorSchema.parse(actor);
  subjectVersionSchema.parse(candidate);
  if (actor.accountId !== candidate.accountId || actor.sourceId !== candidate.sourceId) return "unauthorized";
  if (current === null) return operation === "replace" && candidate.generation === 1 && candidate.revision === 1 ? "advance" : "requires_replace";
  subjectVersionSchema.parse(current);
  if (!sameSubject(candidate, current)) return "wrong_subject";
  const order = compareVersion(candidate, current);
  if (order < 0) return "stale";
  if (order === 0) return "duplicate"; // Equality is not idempotent payload equality; admission checks its hash.
  if (candidate.generation === current.generation) return operation === "update" ? "advance" : "invalid_generation";
  if (operation !== "replace") return "requires_replace";
  return candidate.generation === current.generation + 1 && candidate.revision === 1 ? "advance" : "invalid_generation";
}

// Internal cleanup authority must name the old native activity. This is never an alert/action policy.
export function terminalCleanupDeadline(terminalAt: string): string {
  return plus(terminalAt, RELEVANCE_DEFAULTS.terminalCleanupSeconds);
}
