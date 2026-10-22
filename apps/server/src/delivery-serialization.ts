import { sealedAlertDevices,sealedForDevice } from "./sealed-content.js";
import { createHash } from "node:crypto";
import { activityAlertSound,noticeSound } from "./notification-sounds.js";
import { presentationCommandState } from "./presentation-runtime.js";
import type { ApnsRuntimeJob } from "./apns-runtime.js";
import {
  OWNER_STATE_SURFACES,
  OWNER_STATE_TIMING,
  ownerStateSchema,
  needsYouReasonSchema,
  type InterruptionLevel,
  type NeedsYouReason,
  type OwnerState,
} from "@relo/notification-contracts";

type AlertProjection = {
  kind: "alert";
  alert: { title: string; body: string };
  /** Relo's cue for the moment (notification-sounds.ts), or the system default for a plain notice. */
  sound: string;
  badge: number;
  mutableContent: true;
  category?: string;
  threadId?: string;
  collapseId?: string;
  /** Spec 6.2/7: questions break through Focus, everything else is an ordinary alert. */
  interruptionLevel: InterruptionLevel;
  customData: Record<string, unknown>;
};

type ActivityProjection = {
  kind: "activity";
  operation: "start" | "update" | "end";
  contentState: Record<string, unknown>;
  attributesType?: string;
  attributes?: Record<string, unknown>;
  alert?: { title: string; body: string; sound?: string };
  dismissalDate?: number;
  staleDate?: number;
  priority: 5 | 10;
  relevanceScore: number;
  providerTimestamp: number;
};

export type DeliveryProjection = AlertProjection | ActivityProjection | { kind: "invalid_activity" };

export type DeliverySerializationEvidence = {
  canonicalIntentSha256: string;
  deviceProjectionSha256: string;
};

export type OrdinaryDeliveryIntent = {
  title: string;
  body: string;
  sourceName?: string | null;
  conversationId?: string | null;
  collapseId?: string | null;
  avatarUrl?: string | null;
  imageUrl?: string | null;
  deepLink?: string | null;
  notificationId: string;
  interactionKind?: ApnsRuntimeJob["interactionKind"];
  interactionId?: string | null;
  accountId?: string;
  deviceId?: string;
  serverOriginHash?: string;
  interactionExpiresAt?: Date | null;
  badge?: number;
  payload: Record<string, unknown>;
};

export class ApnsPayloadTooLargeError extends Error {
  readonly code = "apns_payload_too_large";
  constructor(readonly size: number) {
    super(`Ordinary APNs payload is ${size} bytes; maximum is 4096 bytes`);
    this.name = "ApnsPayloadTooLargeError";
  }
}

export class DeliverySerializationValidationError extends Error {
  constructor() {
    super("Delivery intent cannot be serialized under its durable revision");
    this.name = "DeliverySerializationValidationError";
  }
}

export function deliverySerializationEvidence(job: ApnsRuntimeJob): DeliverySerializationEvidence {
  try {
    return {
      canonicalIntentSha256: sha256({
        transport: job.transport,
        notificationId: job.notificationId,
        createdAt: job.createdAt.toISOString(),
        expiresAt: job.expiresAt?.toISOString() ?? null,
        privacy: isPrivate(job.payload) ? "private" : "standard",
        interactionKind: job.interactionKind,
        activity: activityIntentIdentity(job.activityCommand),
      }),
      deviceProjectionSha256: sha256(deliveryProjection(job)),
    };
  } catch (error) {
    if (error instanceof DeliverySerializationValidationError) throw error;
    throw new DeliverySerializationValidationError();
  }
}

function activityIntentIdentity(command: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!command) return null;
  return Object.fromEntries([
    "operation","activityId","generation","sequence","providerTimestamp","dismissAfterSeconds",
  ].filter((key) => command[key] === null || ["string","number","boolean"].includes(typeof command[key]))
    .map((key) => [key,command[key]]));
}

export function deliveryProjection(job: ApnsRuntimeJob): DeliveryProjection {
  if (job.transport === "notification") {
    return ordinaryDeliveryProjection(job);
  }
  return activityProjection(job);
}

export function assertOrdinaryDeliveryIntentWithinBudget(input: OrdinaryDeliveryIntent): void {
  // A sealed notice pushes a different alert envelope to each phone: measure every one.
  const sealedDevices = sealedAlertDevices(input.payload);
  const sizes = sealedDevices.length && input.deviceId === undefined
    ? sealedDevices.map((deviceId) => ordinaryDeliveryPayloadSize({ ...input,deviceId }))
    : [ordinaryDeliveryPayloadSize(input)];
  const size = Math.max(...sizes);
  if (size > 4_096) throw new ApnsPayloadTooLargeError(size);
}

export function ordinaryDeliveryPayloadSize(input: OrdinaryDeliveryIntent): number {
  const projection = ordinaryDeliveryProjection({
    ...input,
    // Every ordinary alert carries receipt scope, including private/noninteractive alerts.
    // Admission runs before exact recipients exist, so reserve their full opaque IDs.
    accountId: input.accountId ?? "acc_00000000-0000-4000-8000-000000000000",
    deviceId: input.deviceId ?? "dev_00000000-0000-4000-8000-000000000000",
    serverOriginHash: input.serverOriginHash ?? "0".repeat(64),
    ...(input.interactionKind ? {
      interactionExpiresAt: input.interactionExpiresAt ?? new Date("9999-12-31T23:59:59.999Z"),
    } : {}),
    badge: input.badge ?? Number.MAX_SAFE_INTEGER,
  });
  const aps: Record<string, unknown> = {
    alert: projection.alert,
    sound: projection.sound,
    badge: projection.badge,
    "mutable-content": 1,
    ...(projection.category ? { category: projection.category } : {}),
    ...(projection.threadId ? { "thread-id": projection.threadId } : {}),
    "interruption-level": projection.interruptionLevel,
  };
  return Buffer.byteLength(JSON.stringify({ ...projection.customData,aps }));
}

/** startedAt uses the same epoch-seconds encoding as updatedAt; omitted when the command predates it. */
function startedAtState(command: Record<string, unknown>): { startedAt?: number } {
  const value = command.startedAt;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? { startedAt: value } : {};
}

export function activityContentState(
  command: Record<string, unknown>,
  privacy: "private" | "standard",
  timestamp: number,
): Record<string, unknown> {
  const generation = requiredActivityGeneration(command.generation);
  const presentation = presentationCommandState(command);
  if (presentation) {
    if (privacy === "private") assertPrivatePresentationState(presentation);
    return {
      generation,
      ...presentation,
      updatedAt: timestamp,
      ...startedAtState(command),
      sequence: finiteInteger(command.sequence, 0, Number.MAX_SAFE_INTEGER, 0),
      expiresAt: nullableEpochSeconds(command.expiresAt),
      staleAt: ownerStaleAt(command),
      owner: ownerContent(command),
      interaction: privacy === "private" ? null : (jsonObject(command.interaction) ?? null),
      // This phone's sealed card or question text, opened by the widget (E5).
      ...(privacy === "standard" && jsonObject(command.sealed) ? { sealed: command.sealed } : {}),
    };
  }
  return {
    generation,
    headline: privacy === "private" ? "Private activity" : stringValue(command.headline, "Relo activity"),
    detail: privacy === "private" ? null : nullableString(command.detail),
    progress: privacy === "private" ? null : finiteNumber(command.progress),
    status: privacy === "private" ? "Open Relo to view" : stringValue(command.status, "In progress"),
    updatedAt: timestamp,
    ...startedAtState(command),
    sequence: finiteInteger(command.sequence, 0, Number.MAX_SAFE_INTEGER, 0),
    style: privacy === "private" ? "standard" : stringValue(command.style, "standard"),
    symbol: privacy === "private" ? "terminal" : stringValue(command.symbol, "terminal"),
    accentColor: privacy === "private" ? "#5ED8B7" : stringValue(command.accentColor, "#5ED8B7"),
    privacy,
    expiresAt: nullableEpochSeconds(command.expiresAt),
    staleAt: ownerStaleAt(command),
    owner: ownerContent(command),
    primaryLabel: privacy === "private" ? null : nullableString(command.primaryLabel),
    secondaryLabel: privacy === "private" ? null : nullableString(command.secondaryLabel),
    interaction: privacy === "private" ? null : (jsonObject(command.interaction) ?? null),
  };
}

function assertPrivatePresentationState(presentation: Record<string, unknown>): void {
  if (presentation.privacy !== "private"
    || presentation.header !== "Relo"
    || presentation.title !== "Private activity"
    || presentation.subtitle !== null
    || presentation.status !== "Open Relo to view"
    || presentation.behaviorType !== "informational"
    || presentation.primaryAction !== null
    || presentation.primaryLabel !== null
    || presentation.secondaryAction !== null
    || presentation.secondaryLabel !== null) {
    throw new DeliverySerializationValidationError();
  }
  if (presentation.componentsJson !== "[]"
    || !sameJson(presentation.surfacesJson,{
      compact_leading: [],compact_trailing: [],expanded_bottom: [],expanded_leading: [],
      expanded_trailing: [],lock_screen: [],minimal: [],
    })
    || !sameJson(presentation.identityJson,{ direct: false,project: null,thread: null })
    || !sameJson(presentation.appearanceJson,{
      roles: { cardIdentity: "neutral",componentIdentity: "neutral",statusEmphasis: "neutral" },
      theme: "system",
    })) {
    throw new DeliverySerializationValidationError();
  }
  const state = parsedJsonObject(presentation.stateJson);
  if (!state || state.tone !== "neutral" || state.icon !== "lock"
    || Object.keys(state).some((key) => !["kind","tone","icon"].includes(key))) {
    throw new DeliverySerializationValidationError();
  }
}

function sameJson(value: unknown, expected: Record<string, unknown>): boolean {
  const parsed = parsedJsonObject(value);
  return parsed !== undefined
    && JSON.stringify(canonicalJson(parsed)) === JSON.stringify(canonicalJson(expected));
}

function parsedJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return plainObject(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function activityProjection(job: ApnsRuntimeJob): ActivityProjection | { kind: "invalid_activity" } {
  const command = job.activityCommand;
  if (!command) return { kind: "invalid_activity" };
  const operation: ActivityProjection["operation"] = job.transport === "live_activity_start"
    ? "start"
    : command.operation === "end" ? "end" : "update";
  const timestamp = finiteInteger(
    command.providerTimestamp,
    0,
    Number.MAX_SAFE_INTEGER,
    Math.floor(job.createdAt.getTime() / 1_000),
  );
  const privacy = command.privacy === "private" || command.privacyMode === "private" ? "private" : "standard";
  const activityGeneration = requiredActivityGeneration(command.generation);
  // The alert's cue is the card's own moment (a question, a failure, a finish); a card starting is silent.
  const cue = activityAlertSound(commandOwner(command)?.state);
  const withCue = <T extends { title: string; body: string }>(alert: T): T & { sound?: string } =>
    cue ? { ...alert,sound: cue } : alert;
  const common = {
    kind: "activity" as const,
    operation,
    contentState: activityContentState(command, privacy, timestamp),
    priority: deliveryPriority(command, operation),
    relevanceScore: ownerRelevance(command, operation),
    providerTimestamp: timestamp,
  };
  if (operation === "start") {
    return {
      ...common,
      attributesType: "ReloActivityAttributes",
      attributes: {
        eventID: stringValue(command.activityId, ""),
        generation: activityGeneration,
        sourceName: privacy === "private" ? "Relo" : stringValue(command.sourceName, "Relo"),
        style: privacy === "private" ? "standard" : stringValue(command.style, "standard"),
        accountID: requiredString(job.accountId),
      },
      alert: withCue(privacy === "private"
        ? { title: "Agent task started", body: "Open Relo to view progress." }
        : {
          title: stringValue(command.headline, "Relo activity"),
          body: stringValue(command.status, "In progress"),
        }),
    };
  }
  if (operation === "end") {
    return {
      ...common,
      dismissalDate: timestamp + ownerDismissAfterSeconds(command),
    };
  }
  const staleDate = ownerStaleAt(command) ?? undefined;
  // An update alerts only when a question lands on the card; routine progress stays silent.
  const alert = command.alertOwner === "apns" && privacy === "standard"
    ? withCue({ title: stringValue(command.title, stringValue(command.headline, "Relo")),
      body: stringValue(command.subtitle, stringValue(command.status, "Needs you")) })
    : undefined;
  return { ...common, ...(staleDate === undefined ? {} : { staleDate }), ...(alert ? { alert } : {}) };
}

function interactionCategory(kind: ApnsRuntimeJob["interactionKind"]): string | undefined {
  return kind === "approval" ? "RELO_APPROVAL"
    : kind === "yes_no" ? "RELO_YES_NO"
      // The phone's notification extension swaps in a category whose buttons carry the labels.
      : kind === "choice" ? "RELO_CHOICE"
        : kind === "text" ? "RELO_TEXT" : undefined;
}

/** "New device/computer wants access" notices (device-approvals.ts): the phone shows Approve / Decline. */
function deviceAccessCategory(payload: Record<string, unknown> | null | undefined): string | undefined {
  // A browser asking to be linked has one action, Review: the owner compares the link code before approving.
  if (plainObject(payload?.browserLink)) return "RELO_BROWSER_LINK";
  return plainObject(payload?.deviceApproval) || plainObject(payload?.computerApproval) ? "RELO_DEVICE_ACCESS" : undefined;
}

function ordinaryDeliveryProjection(input: OrdinaryDeliveryIntent): AlertProjection {
  // Questions answered in Relo (the phone could not show a card) carry no answer buttons.
  const answerInApp = Boolean((input.payload as Record<string,unknown> | null | undefined)?.answerInApp);
  const categoryName = answerInApp ? undefined
    : interactionCategory(input.interactionKind ?? null) ?? deviceAccessCategory(input.payload);
  return {
    kind: "alert",
    alert: ordinaryAlert(input),
    sound: noticeSound({ interactionKind: input.interactionKind ?? null,payload: input.payload }),
    badge: input.badge ?? 0,
    mutableContent: true,
    ...(categoryName ? { category: categoryName } : {}),
    ...(!isPrivate(input.payload) && input.conversationId ? { threadId: input.conversationId } : {}),
    ...(input.collapseId ? { collapseId: input.collapseId } : {}),
    interruptionLevel: ordinaryInterruptionLevel(input, answerInApp),
    customData: ordinaryCustomData(input),
  };
}

function ordinaryAlert(input: OrdinaryDeliveryIntent): { title: string; body: string } {
  return isPrivate(input.payload)
    ? { title: "Relo", body: "New private notification" }
    : { title: input.title, body: input.body };
}

function ordinaryCustomData(input: OrdinaryDeliveryIntent): Record<string, unknown> {
  const privacy = isPrivate(input.payload) ? "private" : "standard";
  const data: Record<string, unknown> = { privacy };
  // Only this phone's sealed alert rides in the push; its Notification Service Extension opens it.
  const sealed = sealedForDevice(input.payload,input.deviceId);
  if (sealed?.alert) data.sealed = sealed.alert;
  if (input.serverOriginHash !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(input.serverOriginHash)
        || !/^acc_[A-Za-z0-9-]{8,}$/.test(input.accountId ?? "")
        || !/^dev_[A-Za-z0-9-]{8,}$/.test(input.deviceId ?? "")) {
      throw new DeliverySerializationValidationError();
    }
    data.receiptScope = { serverOriginHash: input.serverOriginHash, accountId: input.accountId, deviceId: input.deviceId };
  }
  const interactionId = typeof input.interactionId === "string"
    ? input.interactionId
    : typeof input.payload.interactionId === "string" ? input.payload.interactionId : null;
  if (interactionId && /^int_[A-Za-z0-9-]{8,}$/.test(interactionId)) {
    data.interactionId = interactionId;
  }
  if (input.interactionKind) data.interactionType = input.interactionKind;
  if (input.interactionKind === "choice" && Array.isArray(input.payload.interactionOptions)) {
    data.interactionOptions = input.payload.interactionOptions;
  }
  if (input.interactionKind && interactionId) {
    if (input.accountId) data.accountId = input.accountId;
    if (input.deviceId) data.deviceId = input.deviceId;
    if (input.interactionExpiresAt) data.interactionExpiresAt = input.interactionExpiresAt.toISOString();
  }
  if (privacy === "standard") {
    const context = plainObject(input.payload.context);
    if (context) {
      const safeContext = Object.fromEntries(["providerName", "computer", "account", "project", "threadName", "taskTitle"]
        .filter((key) => typeof context[key] === "string")
        .map((key) => [key, context[key]]));
      if (Object.keys(safeContext).length > 0) data.context = safeContext;
    }
  }
  return {
    relo: {
      ...data,
      notificationId: input.notificationId,
      sourceName: privacy === "private"
        ? "Relo"
        : typeof input.sourceName === "string" ? input.sourceName.trim().slice(0, 80) || "Relo" : "Relo",
      ...(privacy === "standard" && input.conversationId ? { conversationId: input.conversationId } : {}),
      avatarUrl: privacy === "private" ? null : (input.avatarUrl ?? null),
      imageUrl: privacy === "private" ? null : (input.imageUrl ?? null),
      deepLink: privacy === "private" ? null : (input.deepLink ?? null),
    },
  };
}

/**
 * Spec 7 alert levels for ordinary notifications: a question (any interaction kind, including the
 * "answer in Relo" fallback notice) is time-sensitive; plain notify and device-access notices stay
 * active; a work's outcome notification is passive unless it failed. Live Activity updates never carry a level.
 */
export function ordinaryInterruptionLevel(input: OrdinaryDeliveryIntent, answerInApp: boolean): InterruptionLevel {
  if (input.interactionKind || answerInApp) return "time-sensitive";
  // A work's outcome notification (works/outcome-notification.ts) names its own level: passive for delivered and finished.
  return (input.payload as Record<string,unknown> | null | undefined)?.interruptionLevel === "passive" ? "passive" : "active";
}

/**
 * The derived owner state a card command carries (`command.owner`, set from deriveOwnerState in the
 * command's transaction). Everything display-related on a card push is read from it and the fixed
 * contract table, never from producer-tuned fields or status text.
 */
type CommandOwner = { state: OwnerState; needsYou: NeedsYouReason | null; staleDate: string | null; changed: boolean };

export function commandOwner(command: Record<string, unknown>): CommandOwner | null {
  const owner = plainObject(command.owner);
  if (!owner) return null;
  const state = ownerStateSchema.safeParse(owner.state);
  if (!state.success) return null;
  const needsYou = needsYouReasonSchema.nullable().safeParse(owner.needsYou ?? null);
  return {
    state: state.data,
    needsYou: needsYou.success ? needsYou.data : null,
    staleDate: typeof owner.staleDate === "string" ? owner.staleDate : null,
    // The command builder sets `changed` when this push moves the card to a new owner state.
    changed: owner.changed === true,
  };
}

/** Content-state `owner`: what the widget renders from; private cards still carry it (no content). */
function ownerContent(command: Record<string, unknown>): { state: OwnerState; needsYou: NeedsYouReason | null } | null {
  const owner = commandOwner(command);
  return owner ? { state: owner.state, needsYou: owner.needsYou } : null;
}

/** ActivityKit staleDate = evidence + T_fresh (derive() owns it); the producer's stale-after is ignored. */
function ownerStaleAt(command: Record<string, unknown>): number | null {
  const owner = commandOwner(command);
  if (owner?.staleDate) return nullableEpochSeconds(owner.staleDate);
  const evidenceAt = isoEpochSeconds(command.evidenceAt) ?? isoEpochSeconds(command.updatedAt);
  return evidenceAt === undefined ? null : evidenceAt + OWNER_STATE_TIMING.freshSeconds;
}

/** ActivityKit relevance-score from the table; it ranks cards for the 3-card Lock Screen rule. */
function ownerRelevance(command: Record<string, unknown>, operation: ActivityProjection["operation"]): number {
  if (operation === "end") return 0;
  const owner = commandOwner(command);
  return owner ? OWNER_STATE_SURFACES[owner.state].relevance : OWNER_STATE_SURFACES.moving.relevance;
}

/**
 * APNs priority: 10 for start/end, for a push that changes the owner state and for the table's
 * questions and outcomes (needs_you, failed, done); 5 for plain progress so it never spends the
 * budget questions need.
 */
function deliveryPriority(command: Record<string, unknown>, operation: ActivityProjection["operation"]): 5 | 10 {
  // A card restarted at the Live Activity limit is not news: the lowest allowed priority.
  if (command.quietRestart === true) return 5;
  if (operation !== "update") return 10;
  const owner = commandOwner(command);
  if (!owner) return 5;
  return owner.changed ? 10 : OWNER_STATE_SURFACES[owner.state].apnsPriority;
}

/** End dismissal from the table: a final card stays its window (done 15 min, failed 60 min), others leave at once. */
function ownerDismissAfterSeconds(command: Record<string, unknown>): number {
  const owner = commandOwner(command);
  if (!owner) return 0;
  const surface = OWNER_STATE_SURFACES[owner.state];
  return surface.dismissal === "after" ? surface.lockScreenSeconds ?? 0 : 0;
}

function isPrivate(payload: Record<string, unknown>): boolean {
  return payload.privacy === "private";
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DeliverySerializationValidationError();
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function requiredActivityGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Live Activity generation must be a positive integer");
  }
  return value;
}

function isoEpochSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp >= 0 ? Math.floor(timestamp / 1_000) : undefined;
}

function nullableEpochSeconds(value: unknown): number | null {
  return isoEpochSeconds(value) ?? null;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  const object = plainObject(value);
  if (!object) return undefined;
  try {
    return JSON.parse(JSON.stringify(object)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex");
}

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Delivery serialization contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]));
  }
  throw new Error("Delivery serialization contains a non-JSON value");
}
