import { createHash } from "node:crypto";
import { presentationCommandState } from "./presentation-runtime.js";
import type { ApnsRuntimeJob } from "./apns-runtime.js";

type AlertProjection = {
  kind: "alert";
  alert: { title: string; body: string };
  sound: "default";
  badge: number;
  mutableContent: true;
  category?: string;
  threadId?: string;
  collapseId?: string;
  customData: Record<string, unknown>;
};

type ActivityProjection = {
  kind: "activity";
  operation: "start" | "update" | "end";
  contentState: Record<string, unknown>;
  attributesType?: string;
  attributes?: Record<string, unknown>;
  alert?: { title: string; body: string };
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
  const size = ordinaryDeliveryPayloadSize(input);
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
  };
  return Buffer.byteLength(JSON.stringify({ ...projection.customData,aps }));
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
      sequence: finiteInteger(command.sequence, 0, Number.MAX_SAFE_INTEGER, 0),
      expiresAt: nullableEpochSeconds(command.expiresAt),
      staleAt: nullableEpochSeconds(command.staleAt),
      interaction: privacy === "private" ? null : (jsonObject(command.interaction) ?? null),
    };
  }
  return {
    generation,
    headline: privacy === "private" ? "Private activity" : stringValue(command.headline, "Relo activity"),
    detail: privacy === "private" ? null : nullableString(command.detail),
    progress: privacy === "private" ? null : finiteNumber(command.progress),
    status: privacy === "private" ? "Open Relo to view" : stringValue(command.status, "In progress"),
    updatedAt: timestamp,
    sequence: finiteInteger(command.sequence, 0, Number.MAX_SAFE_INTEGER, 0),
    style: privacy === "private" ? "standard" : stringValue(command.style, "standard"),
    symbol: privacy === "private" ? "terminal" : stringValue(command.symbol, "terminal"),
    accentColor: privacy === "private" ? "#5ED8B7" : stringValue(command.accentColor, "#5ED8B7"),
    privacy,
    expiresAt: nullableEpochSeconds(command.expiresAt),
    staleAt: nullableEpochSeconds(command.staleAt),
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
  const common = {
    kind: "activity" as const,
    operation,
    contentState: activityContentState(command, privacy, timestamp),
    priority: deliveryPriority(command, 10),
    relevanceScore: boundedRelevanceScore(command.relevanceScore),
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
      alert: privacy === "private"
        ? { title: "Agent task started", body: "Open Relo to view progress." }
        : {
          title: stringValue(command.headline, "Relo activity"),
          body: stringValue(command.status, "In progress"),
        },
    };
  }
  if (operation === "end") {
    return {
      ...common,
      dismissalDate: timestamp + finiteInteger(command.dismissAfterSeconds, 0, 14_400, 0),
    };
  }
  const staleDate = isoEpochSeconds(command.staleAt);
  // An update alerts only when a question lands on the card; routine progress stays silent.
  const alert = command.alertOwner === "apns" && privacy === "standard"
    ? { title: stringValue(command.title, stringValue(command.headline, "Relo")),
      body: stringValue(command.subtitle, stringValue(command.status, "Needs you")) }
    : undefined;
  return { ...common, ...(staleDate === undefined ? {} : { staleDate }), ...(alert ? { alert } : {}) };
}

function interactionCategory(kind: ApnsRuntimeJob["interactionKind"]): string | undefined {
  return kind === "approval" ? "RELO_APPROVAL"
    : kind === "yes_no" ? "RELO_YES_NO"
      : kind === "text" ? "RELO_TEXT" : undefined;
}

function ordinaryDeliveryProjection(input: OrdinaryDeliveryIntent): AlertProjection {
  // Questions answered in Relo (the phone could not show a card) carry no answer buttons.
  const answerInApp = Boolean((input.payload as Record<string,unknown> | null | undefined)?.answerInApp);
  const categoryName = answerInApp ? undefined : interactionCategory(input.interactionKind ?? null);
  return {
    kind: "alert",
    alert: ordinaryAlert(input),
    sound: "default",
    badge: input.badge ?? 0,
    mutableContent: true,
    ...(categoryName ? { category: categoryName } : {}),
    ...(!isPrivate(input.payload) && input.conversationId ? { threadId: input.conversationId } : {}),
    ...(input.collapseId ? { collapseId: input.collapseId } : {}),
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
  if (input.interactionKind && interactionId) {
    if (input.accountId) data.accountId = input.accountId;
    if (input.deviceId) data.deviceId = input.deviceId;
    if (input.interactionExpiresAt) data.interactionExpiresAt = input.interactionExpiresAt.toISOString();
  }
  if (privacy === "standard") {
    const context = plainObject(input.payload.context);
    if (context) {
      const safeContext = Object.fromEntries(["providerName", "computer", "project", "threadName", "taskTitle"]
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

function deliveryPriority(command: Record<string, unknown>, fallback: 5 | 10): 5 | 10 {
  return command.priority === 5 || command.priority === 10 ? command.priority : fallback;
}

function boundedRelevanceScore(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0.5;
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
