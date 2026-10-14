import { SEALED_CARD_PLACEHOLDERS,safeContextSchema,type WorkPlan } from "@relo/notification-contracts";
import { executeActivityCommand } from "../activity-commands/commands.js";
import { taskActivityRequestHash } from "../activity-commands/runtime.js";
import { activityEndSchema,activityStartSchema,activityUpdateSchema,type ApnsMode } from "../activity-commands/schemas.js";
import type { ActivityActor } from "../activity-commands/types.js";
import type { Database } from "../db.js";
import { internalId } from "../ids.js";
import { applyActivityPrivacyPolicy,loadClientPresentationPolicy,resolveActivityPresentation } from "../presentation-policy.js";
import { sealedNoticeSchema } from "../sealed-content.js";
import { requireWorkIdentity } from "../work-identity.js";
import type { WorkRow } from "./store.js";

/** What a sealed work's card shows where it would show text the server cannot read. */
// The phone swaps only these exact placeholders for the text it opens.
const SEALED_WORK_TITLE = SEALED_CARD_PLACEHOLDERS.title;
const SEALED_WORK_STATUS = SEALED_CARD_PLACEHOLDERS.status;
/** How long a finished card stays before it fades (seconds); failures stay longer. */
const FINISHED_DISMISS_SECONDS = 900;
const FAILED_DISMISS_SECONDS = 3_600;
const CARD_STEP_WINDOW = 8;

const clip = (value: string,max: number) => value.length > max ? `${value.slice(0,max - 1)}…` : value;

/** Visible steps (skipped omitted) as the card's semantic steps, windowed around the current step. */
function cardSteps(plan: WorkPlan | null): { labels: string[]; current: number } | undefined {
  const visible = (plan?.steps ?? []).filter((step) => step.state !== "skipped");
  if (!visible.length) return undefined;
  let currentIndex = visible.findIndex((step) => step.state === "current");
  if (currentIndex < 0) currentIndex = visible.length - 1;
  const start = Math.max(0,Math.min(currentIndex - 2,visible.length - CARD_STEP_WINDOW));
  const window = visible.slice(start,start + CARD_STEP_WINDOW);
  return {
    labels: window.map((step) => clip(step.label ?? `Step ${step.id.slice(1)}`,40)),
    current: currentIndex - start + 1,
  };
}

function cardProgress(work: WorkRow): number | undefined {
  const current = work.plan?.steps.find((step) => step.state === "current");
  if (current?.progress) return Math.min(1,current.progress.done / current.progress.total);
  if (work.progress_m) return Math.min(1,(work.progress_n ?? 0) / work.progress_m);
  return undefined;
}

function cardText(work: WorkRow) {
  return {
    title: clip(work.sealed_text ? SEALED_WORK_TITLE : work.goal ?? "Work",80),
    status: clip(work.sealed_text ? SEALED_WORK_STATUS : work.waiting_reason ?? work.status ?? "Working",60),
  };
}

function cardSealed(work: WorkRow) {
  const parsed = sealedNoticeSchema.safeParse(work.sealed);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The card's identity from its work's declared context. The goal is the card's title, so a work without
 * a topic (no session name yet) has none: the card reads "<source> · <project>", never a made-up name.
 */
export function cardContext(work: WorkRow): Record<string,unknown> {
  const context = (work.context ?? {}) as Record<string,unknown>;
  const pick = (key: string,max: number) => typeof context[key] === "string" ? clip(context[key] as string,max) : undefined;
  return Object.fromEntries(Object.entries({
    providerName: pick("providerName",80),
    computer: pick("computer",120),
    project: pick("project",120) ?? "Relo",
    threadName: pick("threadName",160),
  }).filter(([,value]) => value !== undefined));
}

/**
 * Cards are views of works: after a committed work write, start, update or end that work's card
 * through the existing activity commands.
 * TODO(slice 2): run inside the work's transaction (spec 2.1d); today the card follows after commit,
 * and a failed projection leaves the work correct and the card behind until the next write.
 */
export async function projectWorkCard(db: Database,apnsMode: ApnsMode,actor: Extract<ActivityActor,{ kind: "credential" }>,
  work: WorkRow): Promise<void> {
  try {
    const card = (await db.query<{ id: string }>(`SELECT id FROM live_activities WHERE work_id=$1 AND state='active'
      ORDER BY created_at DESC LIMIT 1`,[work.id])).rows[0];
    if (work.lifecycle === "open") {
      if (card) await updateCard(db,apnsMode,actor,work,card.id);
      else await startCard(db,apnsMode,actor,work);
      return;
    }
    if (!card) return;
    const finished = work.lifecycle === "finished" || work.lifecycle === "failed" || work.lifecycle === "dropped";
    const status = work.sealed_text ? SEALED_WORK_STATUS
      : clip((finished ? work.outcome : work.status) ?? (work.lifecycle === "paused" ? "Paused" : "Done"),60);
    const dismissAfterSeconds = work.lifecycle === "finished" ? FINISHED_DISMISS_SECONDS
      : work.lifecycle === "failed" ? FAILED_DISMISS_SECONDS : 0;
    const sealed = cardSealed(work);
    const input = activityEndSchema.parse({
      status,dismissAfterSeconds,...(work.lifecycle === "failed" ? { symbol: "warning" } : {}),...(sealed ? { sealed } : {}),
    });
    await executeActivityCommand(db,actor,{ operation: "end",activityId: card.id,idempotencyKey: undefined,
      requestHash: taskActivityRequestHash("end",{ work: work.id,version: work.version }),input,apnsMode });
  } catch (error) {
    console.warn(JSON.stringify({ event: "work_card_projection_failed",work: work.id,
      error: error instanceof Error ? error.message : String(error) }));
  }
}

async function startCard(db: Database,apnsMode: ApnsMode,actor: Extract<ActivityActor,{ kind: "credential" }>,work: WorkRow) {
  const sealed = cardSealed(work);
  const steps = cardSteps(work.plan);
  const progress = cardProgress(work);
  const parsed = activityStartSchema.parse({
    key: `work-${work.id}`,acquireMode: "ensure",...cardText(work),
    ...(steps ? { steps } : {}),...(progress !== undefined ? { progress } : {}),
    context: cardContext(work),...(sealed ? { sealed } : {}),
  });
  const identity = requireWorkIdentity(`credential:${actor.credentialId}`,parsed.context,parsed.origin,{ topic: "optional" });
  if (!identity.ok) return;
  const rawInput = { ...parsed,context: identity.context };
  const effective = await loadClientPresentationPolicy(db,actor.principalId,actor.credentialId);
  const resolved = resolveActivityPresentation(rawInput,{ principalId: actor.principalId,effective });
  const result = await executeActivityCommand(db,actor,{
    operation: "start",source: "producer",rawInput,storedPresentation: resolved.stored,presentationPolicy: resolved.snapshot,
    requestedDeviceIds: null,idempotencyKey: undefined,requestHash: taskActivityRequestHash("start",{ work: work.id,version: work.version }),apnsMode,
  });
  if (result.kind !== "started") return;
  const activityId = internalId("act",result.receipt.activity.id) ?? result.receipt.activity.id;
  // The card copies its work's identity (spec 2.2) so card readers see the session.
  await db.query(`UPDATE live_activities SET work_id=$2,producer_type=$3,session_key=$4
    WHERE id=$1 AND principal_id=$5`,[activityId,work.id,work.producer_type,work.session_key,work.principal_id]);
}

async function updateCard(db: Database,apnsMode: ApnsMode,actor: Extract<ActivityActor,{ kind: "credential" }>,work: WorkRow,cardId: string) {
  const sealed = cardSealed(work);
  const steps = cardSteps(work.plan);
  const progress = cardProgress(work);
  // The identity follows the work (a renamed session renames its card); the topic is no subtitle.
  const declared = safeContextSchema.safeParse(cardContext(work));
  const identity = requireWorkIdentity(`credential:${actor.credentialId}`,declared.success ? declared.data : undefined,undefined,
    { topic: "optional" });
  const raw = activityUpdateSchema.parse({
    ...cardText(work),...(steps ? { steps } : {}),...(progress !== undefined ? { progress } : {}),...(sealed ? { sealed } : {}),
    ...(identity.ok ? { context: identity.context,detail: null } : {}),
  });
  const policy = await loadClientPresentationPolicy(db,actor.principalId,actor.credentialId);
  const input = applyActivityPrivacyPolicy(raw,policy.policy);
  await executeActivityCommand(db,actor,{ operation: "update",activityId: cardId,idempotencyKey: undefined,
    requestHash: taskActivityRequestHash("update",{ work: work.id,version: work.version }),input,apnsMode,policy });
}
