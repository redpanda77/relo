import { createHash } from "node:crypto";
import { EMPTY_WORK_PLAN,lastRound,type InterruptionLevel } from "@relo/notification-contracts";
import type { Database } from "../db.js";
import { internalId,publicId } from "../ids.js";
import { prepareNotificationContent } from "../notification-content.js";
import { createNotificationInTransaction } from "../notifications/commands.js";
import type { NotificationActor,NotificationDependencies } from "../notifications/types.js";
import type { SubjectTransaction } from "../relevance/commands.js";
import { checkSealedNotice,SEALED_BODY,SEALED_TITLE,sealedNoticeSchema,type SealedNotice } from "../sealed-content.js";
import { cardContext } from "./card-projection.js";
import type { WorkRow } from "./store.js";

/**
 * The outcome notification (plan 14, workstream 2a; RELO-PLAN 2.13 "rest"): one notification when a producer
 * delivers a round or finishes a work, the only buzz a work makes on its own. Levels follow Apple's
 * interruption levels: delivered and finished are passive, failed is active, dropped (and anything the owner
 * ended) makes none. It is a message: it reads the work and never writes it. One key per work and round, so a
 * retried deliver or finish, or a finish right after the delivery of the same round, never notifies twice.
 */
export type WorkOutcomeKind = "delivered" | "finished" | "failed" | "dropped";

const OUTCOME_LEVEL: Record<WorkOutcomeKind,InterruptionLevel | null> = {
  delivered: "passive",finished: "passive",failed: "active",dropped: null,
};
const FALLBACK_BODY: Record<WorkOutcomeKind,string> = { delivered: "Delivered",finished: "Finished",failed: "Failed",dropped: "Stopped" };
const clip = (value: string,max: number) => value.length > max ? `${value.slice(0,max - 1)}…` : value;

export function outcomeKindOf(work: Pick<WorkRow,"lifecycle">): WorkOutcomeKind | null {
  return work.lifecycle === "finished" || work.lifecycle === "failed" || work.lifecycle === "dropped" ? work.lifecycle : null;
}

/** A failure keys apart from the delivery of the same round, so a failure right after a deliver still alerts. */
export const outcomeKey = (work: Pick<WorkRow,"id" | "plan">,kind: WorkOutcomeKind) =>
  `outcome:${work.id}:${lastRound(work.plan ?? EMPTY_WORK_PLAN).n}${kind === "failed" ? ":failed" : ""}`;

/**
 * A request's `sealedOutcome`: the outcome notification sealed by the CLI as kind "notice" (title and outcome),
 * never the card's envelopes (the phone opens those as a card). Null when the request carries none.
 */
export function readSealedOutcome(input: unknown): { sealed: SealedNotice | null } | { error: "invalid_sealed_content" } {
  const raw = input && typeof input === "object" ? (input as { sealedOutcome?: unknown }).sealedOutcome : undefined;
  if (raw === undefined) return { sealed: null };
  const parsed = sealedNoticeSchema.safeParse(raw);
  return parsed.success && checkSealedNotice(parsed.data,"notice").ok ? { sealed: parsed.data } : { error: "invalid_sealed_content" };
}

function actorOf(work: WorkRow): NotificationActor | null {
  if (work.producer_type === "service") return work.service_id ? { kind: "service",principalId: work.principal_id,serviceId: work.service_id } : null;
  return work.credential_id ? { kind: "credential",principalId: work.principal_id,credentialId: work.credential_id } : null;
}

/**
 * Creates the outcome notification inside the caller's transaction, behind a savepoint: a notification that
 * cannot be made (no cipher, dropped, a duplicate key) never fails or undoes the work write.
 */
export async function recordWorkOutcome(tx: SubjectTransaction,work: WorkRow,kind: WorkOutcomeKind,
  dependencies: NotificationDependencies | undefined,sealedOutcome: SealedNotice | null = null): Promise<"created" | "skipped"> {
  const level = OUTCOME_LEVEL[kind];
  const actor = actorOf(work);
  if (!level || !actor || !dependencies?.contentCipher) return "skipped";
  const round = lastRound(work.plan ?? EMPTY_WORK_PLAN);
  const readableOutcome = kind === "delivered" ? round.outcome : work.outcome;
  const cardPrivate = (await tx.query<{ privacy: string }>(
    "SELECT privacy FROM live_activities WHERE work_id=$1 ORDER BY created_at DESC LIMIT 1",[work.id])).rows[0]?.privacy === "private";
  // A sealed work's notification carries only its own sealed notice; without one, the placeholder text (never the card's envelopes).
  const sealed = work.sealed_text && sealedOutcome ? { success: true as const,data: sealedOutcome } : null;
  const generic = work.sealed_text || cardPrivate;
  const title = work.sealed_text ? SEALED_TITLE : cardPrivate ? "Private notification" : clip(work.goal ?? work.source_name ?? "Relo",80);
  const content = work.sealed_text ? prepareNotificationContent({ body: SEALED_BODY })
    : cardPrivate ? prepareNotificationContent({ body: "Open Relo to view",summary: "Private notification" })
      : prepareNotificationContent({ body: readableOutcome?.trim() || FALLBACK_BODY[kind] });
  const deviceIds = sealed?.success
    ? sealed.data.alerts.map((alert) => internalId("dev",alert.recipients[0]!.device)).filter((id): id is string => Boolean(id))
    : [];
  const key = outcomeKey(work,kind);
  await tx.query("SAVEPOINT work_outcome");
  try {
    const result = await createNotificationInTransaction(tx,actor,{
      idempotencyKey: key,requestHash: createHash("sha256").update(key).digest("hex"),
      sourceName: clip(work.source_name ?? "Relo",80),title,content,imageUrl: null,deepLink: null,
      payload: {
        ...(generic ? { privacy: "private" } : { context: cardContext(work) }),
        ...(sealed?.success ? { sealed: sealed.data } : {}),
        interruptionLevel: level,workOutcome: { workId: publicId("wrk",work.id),round: round.n,result: kind },
      },
      deviceIds: deviceIds.length ? deviceIds : null,originHash: null,
    },dependencies);
    if (result.kind !== "created") { await tx.query("ROLLBACK TO SAVEPOINT work_outcome"); return "skipped"; }
    await tx.query("RELEASE SAVEPOINT work_outcome");
    return "created";
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT work_outcome");
    console.warn(JSON.stringify({ event: "work_outcome_notification_failed",work: work.id,
      error: error instanceof Error ? error.message : String(error) }));
    return "skipped";
  }
}

/** For producers that write without a transaction of their own (scripts): the notification in its own. */
export async function recordWorkOutcomeStandalone(db: Database,work: WorkRow,kind: WorkOutcomeKind,
  dependencies: NotificationDependencies | undefined,sealedOutcome: SealedNotice | null = null): Promise<void> {
  if (!dependencies?.contentCipher) return;
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    await recordWorkOutcome(tx,work,kind,dependencies,sealedOutcome);
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    console.warn(JSON.stringify({ event: "work_outcome_notification_failed",work: work.id,
      error: error instanceof Error ? error.message : String(error) }));
  } finally {
    tx.release();
  }
}
