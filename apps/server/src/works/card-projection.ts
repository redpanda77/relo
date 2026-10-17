import { EMPTY_WORK_PLAN,FACTS,lastRound,planProgressWire,SEALED_CARD_PLACEHOLDERS,safeContextSchema,type PlanProgressWire,type WorkPlan } from "@relo/notification-contracts";
import { executeActivityCommand } from "../activity-commands/commands.js";
import { taskActivityRequestHash } from "../activity-commands/runtime.js";
import { activityEndSchema,activityStartSchema,activityUpdateSchema,type ApnsMode } from "../activity-commands/schemas.js";
import type { Database } from "../db.js";
import { applyActivityPrivacyPolicy,resolveActivityPresentation } from "../presentation-policy.js";
import { sealedNoticeSchema } from "../sealed-content.js";
import { requireWorkIdentity } from "../work-identity.js";
import type { CardActor } from "./card-actor.js";
import type { WorkRow } from "./store.js";

/** What a sealed work's card shows where it would show text the server cannot read. */
// The phone swaps only these exact placeholders for the text it opens.
const SEALED_WORK_TITLE = SEALED_CARD_PLACEHOLDERS.title;
const SEALED_WORK_STATUS = SEALED_CARD_PLACEHOLDERS.status;
/** How long a finished card stays before it fades (seconds); failures stay longer. */
const FINISHED_DISMISS_SECONDS = FACTS.card.doneSeconds;
const FAILED_DISMISS_SECONDS = FACTS.card.failedSeconds;
const CARD_STEP_WINDOW = 8;

const clip = (value: string,max: number) => value.length > max ? `${value.slice(0,max - 1)}…` : value;

/**
 * The card's semantic steps: the TOP-LEVEL steps of the round in play (skipped omitted), windowed around the
 * current one. Substeps never become segments or change the count (plan 14, workstream 7); the current step's
 * own fraction travels in `plan.fill`.
 */
export function cardSteps(plan: WorkPlan | null,options: { readable?: boolean } = {}): { labels: string[]; current: number; before?: number; after?: number; plan?: PlanProgressWire } | undefined {
  // The card shows the round in play (the open one, or the delivered last one), never an earlier round's steps.
  const round = plan?.rounds ? lastRound(plan).n : null;
  const visible = (plan?.steps ?? []).filter((step) => step.state !== "skipped" && step.parent === undefined && (round === null || (step.round ?? 1) === round));
  if (!visible.length) return undefined;
  const wire = planProgressWire(plan,{ readable: options.readable === true,labelMax: 40 });
  // The top-level step that is, or holds, the current step.
  const holder = wire?.currentId ?? null;
  let currentIndex = holder === null ? -1 : visible.findIndex((step) => step.id === holder);
  if (currentIndex < 0) currentIndex = visible.length - 1;
  const start = Math.max(0,Math.min(currentIndex - 2,visible.length - CARD_STEP_WINDOW));
  const window = visible.slice(start,start + CARD_STEP_WINDOW);
  return {
    labels: window.map((step) => clip(step.label ?? `Step ${step.id.slice(1)}`,40)),
    current: currentIndex - start + 1,
    // The window above is what the current phone build draws; it counts the whole plan, not just the window.
    ...(start > 0 ? { before: start } : {}),
    ...(visible.length > start + window.length ? { after: visible.length - start - window.length } : {}),
    // The plan UX count (U1, U2): top-level steps of the round in play, where the work is, its substeps. The
    // phone writes the plan line from this; labels only for a readable work (step labels are clipped as above).
    ...(wire ? { plan: wire } : {}),
  };
}

/**
 * A card's own fraction: only for a work without a plan, and only when the producer sent one. With a plan the
 * fraction belongs to the current step and travels in `plan.fill`, so a standalone percentage never sits beside
 * the step count (the cause of "0 of 4" next to "75%").
 */
export function cardProgress(work: WorkRow): number | undefined {
  if (work.plan?.steps.length) return undefined;
  if (work.progress_m) return Math.min(1,(work.progress_n ?? 0) / work.progress_m);
  return undefined;
}

/** What an update says about progress: a planned work clears any fraction an earlier card carried. */
const cardProgressUpdate = (work: WorkRow,steps: unknown): number | null | undefined => steps ? null : cardProgress(work);

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
 * through the existing activity commands. The same for every producer type; what differs comes from its CardActor.
 * TODO(slice 2): run inside the work's transaction (spec 2.1d); today the card follows after commit,
 * and a failed projection leaves the work correct and the card behind until the next write.
 */
export async function projectWorkCard(db: Database,apnsMode: ApnsMode,producer: CardActor,work: WorkRow): Promise<void> {
  const actor = producer.actor;
  try {
    const card = (await db.query<{ id: string }>(`SELECT id FROM live_activities WHERE work_id=$1 AND state='active'
      ORDER BY created_at DESC LIMIT 1`,[work.id])).rows[0];
    // A delivered work (open, last round closed) has no live card: the deliver ended it as a final card.
    const delivered = work.lifecycle === "open" && lastRound(work.plan ?? EMPTY_WORK_PLAN).state === "closed";
    if (work.lifecycle === "open" && !delivered) {
      if (card) await updateCard(db,apnsMode,producer,work,card.id);
      else await startCard(db,apnsMode,producer,work);
      return;
    }
    if (!card) return;
    const finished = work.lifecycle === "finished" || work.lifecycle === "failed" || work.lifecycle === "dropped";
    const outcome = delivered ? lastRound(work.plan ?? EMPTY_WORK_PLAN).outcome : finished ? work.outcome : work.status;
    const status = work.sealed_text ? SEALED_WORK_STATUS
      : clip(outcome ?? (work.lifecycle === "paused" ? "Paused" : "Done"),60);
    const dismissAfterSeconds = work.lifecycle === "finished" || delivered ? FINISHED_DISMISS_SECONDS
      : work.lifecycle === "failed" ? FAILED_DISMISS_SECONDS : 0;
    const sealed = cardSealed(work);
    // The ended card keeps where the work stood: a delivered round reads "Round 2 delivered", a stopped work "Stopped at 3 of 5".
    const plan = planProgressWire(work.plan,{ readable: !work.sealed_text,labelMax: 40,stopped: work.lifecycle === "failed" || work.lifecycle === "dropped" });
    const input = activityEndSchema.parse({
      status,dismissAfterSeconds,...(plan ? { plan } : {}),...(work.lifecycle === "failed" ? { symbol: "warning" } : {}),...(sealed ? { sealed } : {}),
    });
    // Only a finished or failed work ends its card as an outcome; a paused or dropped one stops where it was.
    const stopped = work.lifecycle === "paused" || work.lifecycle === "dropped";
    await executeActivityCommand(db,actor,{ operation: "end",activityId: card.id,idempotencyKey: undefined,
      ...(stopped ? { stopped: true as const } : {}),
      requestHash: taskActivityRequestHash("end",{ work: work.id,version: work.version }),input,apnsMode });
  } catch (error) {
    console.warn(JSON.stringify({ event: "work_card_projection_failed",work: work.id,
      error: error instanceof Error ? error.message : String(error) }));
  }
}

async function startCard(db: Database,apnsMode: ApnsMode,producer: CardActor,work: WorkRow) {
  const actor = producer.actor;
  const sealed = cardSealed(work);
  const steps = cardSteps(work.plan,{ readable: !work.sealed_text });
  const progress = cardProgress(work);
  const parsed = activityStartSchema.parse({
    key: `work-${work.id}`,acquireMode: "ensure",...cardText(work),
    ...(steps ? { steps } : {}),...(progress !== undefined ? { progress } : {}),
    context: cardContext(work),...(sealed ? { sealed } : {}),
  });
  const identity = requireWorkIdentity(producer.identityNamespace,parsed.context,parsed.origin,{ topic: "optional" });
  if (!identity.ok) return;
  const rawInput = { ...parsed,context: identity.context };
  const effective = await producer.presentationPolicy();
  const computerIcon = await producer.computerIcon();
  const resolved = resolveActivityPresentation(rawInput,{ principalId: actor.principalId,effective,computerIcon });
  await executeActivityCommand(db,actor,{
    operation: "start",source: "producer",rawInput,storedPresentation: resolved.stored,presentationPolicy: resolved.snapshot,
    requestedDeviceIds: null,idempotencyKey: undefined,requestHash: taskActivityRequestHash("start",{ work: work.id,version: work.version }),apnsMode,
    cardIdentity: { workId: work.id,producerType: work.producer_type,sessionKey: work.session_key },
  });
}

async function updateCard(db: Database,apnsMode: ApnsMode,producer: CardActor,work: WorkRow,cardId: string) {
  const actor = producer.actor;
  const sealed = cardSealed(work);
  const steps = cardSteps(work.plan,{ readable: !work.sealed_text });
  const progress = cardProgressUpdate(work,steps);
  // The identity follows the work (a renamed session renames its card); the topic is no subtitle.
  const declared = safeContextSchema.safeParse(cardContext(work));
  const identity = requireWorkIdentity(producer.identityNamespace,declared.success ? declared.data : undefined,undefined,
    { topic: "optional" });
  const raw = activityUpdateSchema.parse({
    ...cardText(work),...(steps ? { steps } : {}),...(progress !== undefined ? { progress } : {}),...(sealed ? { sealed } : {}),
    ...(identity.ok ? { context: identity.context,detail: null } : {}),
  });
  const policy = await producer.presentationPolicy();
  const input = applyActivityPrivacyPolicy(raw,policy.policy);
  await executeActivityCommand(db,actor,{ operation: "update",activityId: cardId,idempotencyKey: undefined,
    requestHash: taskActivityRequestHash("update",{ work: work.id,version: work.version }),input,apnsMode,policy,
    computerIcon: await producer.computerIcon() });
}
