import { planProgressWireSchema } from "./works.js";
import { z } from "zod";

export const LIVE_ACTIVITY_PRESENTATION_MAX_CANONICAL_BYTES = 3_072 as const;
export const LIVE_ACTIVITY_PRESENTATION_APNS_BUDGET_BYTES = 4_096 as const;
export const LIVE_ACTIVITY_PRESENTATION_APNS_RESERVED_ENVELOPE_BYTES = 3_072 as const;
export const LIVE_ACTIVITY_PRESENTATION_LIMITS = Object.freeze({
  header: 40, title: 80, subtitle: 120, status: 80, progressLabel: 32,
  stepCount: 8, stepId: 32, stepLabel: 48, actionLabel: 24,
  assetBytes: 5_000_000, assetAltText: 160,
} as const);

export type StableJsonValue = null | boolean | number | string | StableJsonValue[]
  | { [key: string]: StableJsonValue };

function stableJsonValue(value: unknown, seen: WeakSet<object>): StableJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Stable JSON accepts only finite numbers");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Stable JSON does not accept cyclic values");
    seen.add(value);
    const result = value.map((part) => stableJsonValue(part, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Stable JSON accepts only plain objects");
    }
    if (seen.has(object)) throw new TypeError("Stable JSON does not accept cyclic values");
    seen.add(object);
    const result: Record<string, StableJsonValue> = {};
    for (const key of Object.keys(object).sort()) {
      const part = object[key];
      if (part === undefined) throw new TypeError("Stable JSON does not accept undefined values");
      result[key] = stableJsonValue(part, seen);
    }
    seen.delete(object);
    return result;
  }
  throw new TypeError("Stable JSON accepts only JSON primitive, array, and plain-object values");
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value, new WeakSet()));
}
export function stableJsonByteLength(value: unknown): number {
  return new TextEncoder().encode(stableJsonStringify(value)).byteLength;
}

const singleLine = (maximum: number) => z.string().trim().min(1).max(maximum)
  .refine((value) => !/[\r\n]/u.test(value), "Must be a single line");
const nullableSingleLine = (maximum: number) => singleLine(maximum).nullable();
const colorSchema = z.string().regex(/^#[0-9A-F]{6}$/u, "Color must use uppercase #RRGGBB format");

export const presentationPrivacySchema = z.enum(["standard", "private"]);
export const presentationThemeSchema = z.enum(["system", "light", "dark"]);
export const PRESENTATION_SYMBOLS = [
  "terminal", "code", "build", "success", "warning",
  "info", "question", "reply", "image", "lock",
] as const;
export const presentationSymbolSchema = z.enum(PRESENTATION_SYMBOLS);

export const immutableReloAssetReferenceSchema = z.object({
  kind: z.literal("relo_asset"), assetId: z.string().regex(/^ast_[A-Za-z0-9_-]{12,}$/u),
  revision: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  byteSize: z.number().int().positive().max(LIVE_ACTIVITY_PRESENTATION_LIMITS.assetBytes),
  pixelWidth: z.number().int().positive().max(4_096),
  pixelHeight: z.number().int().positive().max(4_096),
}).strict();
export type ImmutableReloAssetReference = z.infer<typeof immutableReloAssetReferenceSchema>;

export const presentationContentSchema = z.object({
  header: nullableSingleLine(LIVE_ACTIVITY_PRESENTATION_LIMITS.header).default(null),
  title: singleLine(LIVE_ACTIVITY_PRESENTATION_LIMITS.title),
  subtitle: nullableSingleLine(LIVE_ACTIVITY_PRESENTATION_LIMITS.subtitle).default(null),
  status: singleLine(LIVE_ACTIVITY_PRESENTATION_LIMITS.status),
}).strict();
export const presentationStepSchema = z.object({
  id: z.string().trim().min(1).max(LIVE_ACTIVITY_PRESENTATION_LIMITS.stepId)
    .regex(/^[A-Za-z0-9_-]+$/u),
  label: singleLine(LIVE_ACTIVITY_PRESENTATION_LIMITS.stepLabel),
  state: z.enum(["complete", "current", "pending"]),
}).strict();
const presentationStepsSchema = z.array(presentationStepSchema)
  .min(1).max(LIVE_ACTIVITY_PRESENTATION_LIMITS.stepCount)
  .superRefine((items, context) => {
    if (new Set(items.map((item) => item.id)).size !== items.length) {
      context.addIssue({ code: "custom", message: "Step IDs must be unique" });
    }
    if (items.filter((item) => item.state === "current").length > 1) {
      context.addIssue({ code: "custom", message: "At most one step may be current" });
    }
    const ranks = { complete: 0, current: 1, pending: 2 } as const;
    let priorRank = 0;
    for (const [index, item] of items.entries()) {
      const rank = ranks[item.state];
      if (rank < priorRank) context.addIssue({
        code: "custom", path: [index, "state"],
        message: "Steps must be ordered complete, current, then pending",
      });
      priorRank = Math.max(priorRank, rank);
    }
  });

const actionSchema = <Action extends string>(action: Action) => z.object({
  action: z.literal(action), label: singleLine(LIVE_ACTIVITY_PRESENTATION_LIMITS.actionLabel),
}).strict();
/** A choice question offers 2–4 labeled options (docs/CHOICE-QUESTIONS.md). */
export const CHOICE_OPTION_LIMITS = Object.freeze({ minimum: 2, maximum: 4 } as const);
export const choiceOptionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/u,
  "Option ids use 1-32 lowercase letters, digits, - or _");
export const choiceOptionSchema = z.object({
  id: choiceOptionIdSchema, label: singleLine(LIVE_ACTIVITY_PRESENTATION_LIMITS.actionLabel),
}).strict();
export const choiceOptionsSchema = z.array(choiceOptionSchema)
  .min(CHOICE_OPTION_LIMITS.minimum).max(CHOICE_OPTION_LIMITS.maximum)
  .superRefine((options, context) => {
    if (new Set(options.map((option) => option.id)).size !== options.length) {
      context.addIssue({ code: "custom", message: "Option ids must be unique" });
    }
    if (new Set(options.map((option) => option.label.toLowerCase())).size !== options.length) {
      context.addIssue({ code: "custom", message: "Option labels must be unique" });
    }
  });
export type ChoiceOption = z.infer<typeof choiceOptionSchema>;

export const PRESENTATION_BEHAVIOR_TYPES = ["informational", "progress", "approval", "yes_no", "choice"] as const;
export const presentationBehaviorTypeSchema = z.enum(PRESENTATION_BEHAVIOR_TYPES);
export const presentationBehaviorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("informational") }).strict(),
  z.object({ type: z.literal("progress") }).strict(),
  z.object({ type: z.literal("approval"), primary: actionSchema("approve"), secondary: actionSchema("deny") }).strict(),
  z.object({ type: z.literal("yes_no"), primary: actionSchema("yes"), secondary: actionSchema("no") }).strict(),
  z.object({ type: z.literal("choice"), options: choiceOptionsSchema }).strict(),
]);

export const PRESENTATION_COMPONENT_TYPES = ["progress_bar", "steps", "image"] as const;
export const PRESENTATION_SURFACES = [
  "lock_screen", "expanded_leading", "expanded_trailing", "expanded_bottom",
  "compact_leading", "compact_trailing", "minimal",
] as const;
export const PRESENTATION_IDENTITY_ROLES = ["project", "thread", "state", "control", "neutral"] as const;
export const PRESENTATION_STATE_KINDS = [
  "active", "waiting", "needs_action", "completed", "failed", "cancelled", "expired", "superseded",
] as const;
export const PRESENTATION_SEMANTIC_ICONS = [
  ...PRESENTATION_SYMBOLS, "project", "thread", "direct", "active", "waiting", "needs_action",
  "completed", "failed", "cancelled", "expired", "superseded",
  "laptop", "desktop", "server", "cloud",
] as const;
export const presentationComponentTypeSchema = z.enum(PRESENTATION_COMPONENT_TYPES);
export const presentationSurfaceSchema = z.enum(PRESENTATION_SURFACES);
export const presentationIdentityRoleSchema = z.enum(PRESENTATION_IDENTITY_ROLES);
export const presentationStateKindSchema = z.enum(PRESENTATION_STATE_KINDS);
export const presentationSemanticIconSchema = z.enum(PRESENTATION_SEMANTIC_ICONS);

const componentBase = {
  id: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/u),
  colorRole: presentationIdentityRoleSchema.default("project"),
};
const progressFields = {
  value: z.number().finite().min(0).max(1),
  label: nullableSingleLine(LIVE_ACTIVITY_PRESENTATION_LIMITS.progressLabel).default(null),
};
export const presentationProgressBarComponentSchema = z.object({
  ...componentBase, type: z.literal("progress_bar"), ...progressFields,
}).strict();
/** A plan longer than the card's window: steps hidden before it (all done) and after it (not started). */
const hiddenStepCountSchema = z.number().int().min(1).max(99).optional();
export const presentationStepsComponentSchema = z.object({
  ...componentBase, type: z.literal("steps"), items: presentationStepsSchema,
  before: hiddenStepCountSchema, after: hiddenStepCountSchema,
  /** Plan UX U1/U2: the count and where the work is in its plan; the phone writes the plan line from it. */
  plan: planProgressWireSchema.optional(),
}).strict();
export const presentationImageComponentSchema = z.object({
  ...componentBase, type: z.literal("image"), asset: immutableReloAssetReferenceSchema,
  altText: singleLine(LIVE_ACTIVITY_PRESENTATION_LIMITS.assetAltText),
  contentMode: z.enum(["fit", "fill"]).default("fit"),
}).strict();
export const presentationComponentSchema = z.discriminatedUnion("type", [
  presentationProgressBarComponentSchema, presentationStepsComponentSchema,
  presentationImageComponentSchema,
]);

export const presentationIdentityTokenSchema = z.object({
  label: singleLine(48), color: colorSchema, icon: presentationSemanticIconSchema,
  revision: z.number().int().positive().default(1),
  provenance: z.enum(["generated", "owner"]).default("generated"),
}).strict();
export const presentationIdentitySchema = z.object({
  project: presentationIdentityTokenSchema.nullable().default(null),
  thread: presentationIdentityTokenSchema.nullable().default(null),
  direct: z.boolean().default(false),
}).strict().superRefine((identity, context) => {
  if (identity.direct && (identity.project !== null || identity.thread !== null)) {
    context.addIssue({ code: "custom", message: "Direct identity cannot include project or thread identity" });
  }
  if (!identity.direct && identity.thread !== null && identity.project === null) {
    context.addIssue({ code: "custom", path: ["thread"], message: "Thread identity requires project identity" });
  }
});
export const presentationStateSchema = z.object({
  kind: presentationStateKindSchema,
  tone: z.enum(["live", "waiting", "attention", "success", "failure", "neutral"]),
  icon: presentationSemanticIconSchema,
}).strict();
export const presentationAppearanceSchema = z.object({
  theme: presentationThemeSchema.default("system"),
  /** How a progress component draws. Absent means the linear bar, so existing hashes are unchanged. */
  progressDisplay: z.enum(["bar", "ring"]).optional(),
  roles: z.object({
    cardIdentity: presentationIdentityRoleSchema.default("project"),
    componentIdentity: presentationIdentityRoleSchema.default("thread"),
    statusEmphasis: presentationIdentityRoleSchema.default("state"),
  }).strict().default({ cardIdentity: "project", componentIdentity: "thread", statusEmphasis: "state" }),
}).strict();
export const presentationSurfacesSchema = z.object({
  lock_screen: z.array(z.string()).max(8).default([]),
  expanded_leading: z.array(z.string()).max(8).default([]),
  expanded_trailing: z.array(z.string()).max(8).default([]),
  expanded_bottom: z.array(z.string()).max(8).default([]),
  compact_leading: z.array(z.string()).max(2).default([]),
  compact_trailing: z.array(z.string()).max(2).default([]),
  minimal: z.array(z.string()).max(1).default([]),
}).strict();

const presentationBaseSchema = z.object({
  content: presentationContentSchema,
  identity: presentationIdentitySchema.default({ project: null, thread: null, direct: true }),
  state: presentationStateSchema, components: z.array(presentationComponentSchema).max(8).default([]),
  surfaces: presentationSurfacesSchema, behavior: presentationBehaviorSchema.default({ type: "informational" }),
  appearance: presentationAppearanceSchema, privacy: presentationPrivacySchema.default("standard"),
}).strict();
export const liveActivityPresentationSchema = presentationBaseSchema.superRefine((presentation, context) => {
  const ids = presentation.components.map((component) => component.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["components"], message: "Component IDs must be unique" });
  }
  const available = new Set(ids);
  for (const [surface, componentIds] of Object.entries(presentation.surfaces)) {
    if (new Set(componentIds).size !== componentIds.length) {
      context.addIssue({ code: "custom", path: ["surfaces", surface], message: "Surface component IDs must be unique" });
    }
    for (const [index, id] of componentIds.entries()) {
      if (!available.has(id)) context.addIssue({
        code: "custom", path: ["surfaces", surface, index], message: "Surface references an unknown component",
      });
    }
  }
  if (presentation.behavior.type === "progress"
    && !presentation.components.some((component) => component.type !== "image")) {
    context.addIssue({ code: "custom", path: ["components"], message: "Progress behavior requires a progress component" });
  }
  if (stableJsonByteLength(presentation) > LIVE_ACTIVITY_PRESENTATION_MAX_CANONICAL_BYTES) {
    context.addIssue({ code: "custom",
      message: `Canonical presentation exceeds ${LIVE_ACTIVITY_PRESENTATION_MAX_CANONICAL_BYTES} UTF-8 bytes` });
  }
});

export type LiveActivityPresentation = z.infer<typeof liveActivityPresentationSchema>;
export type LiveActivityPresentationInput = z.input<typeof liveActivityPresentationSchema>;
export function parseLiveActivityPresentation(input: unknown): LiveActivityPresentation {
  return liveActivityPresentationSchema.parse(input);
}
export function stableSerializeLiveActivityPresentation(input: unknown): string {
  return stableJsonStringify(parseLiveActivityPresentation(input));
}
export function projectLiveActivityPresentationPrivacy(input: unknown): LiveActivityPresentation {
  const presentation = parseLiveActivityPresentation(input);
  if (presentation.privacy === "standard") return presentation;
  return parseLiveActivityPresentation({
    content: { header: "Relo", title: "Private activity", subtitle: null, status: "Open Relo to view" },
    identity: { project: null, thread: null, direct: true },
    state: { kind: presentation.state.kind, tone: "neutral", icon: "lock" },
    components: [], surfaces: {}, behavior: { type: "informational" },
    appearance: { theme: "system",
      roles: { cardIdentity: "neutral", componentIdentity: "neutral", statusEmphasis: "neutral" } },
    privacy: "private",
  });
}

export type ApnsBudgetMeasurement = { json: string; bytes: number; budgetBytes: number; remainingBytes: number };
export function measureApnsPayloadBudget(payload: unknown): ApnsBudgetMeasurement {
  const json = stableJsonStringify(payload);
  const bytes = new TextEncoder().encode(json).byteLength;
  return { json, bytes, budgetBytes: LIVE_ACTIVITY_PRESENTATION_APNS_BUDGET_BYTES,
    remainingBytes: LIVE_ACTIVITY_PRESENTATION_APNS_BUDGET_BYTES - bytes };
}
export function assertApnsPayloadWithinBudget(payload: unknown): ApnsBudgetMeasurement {
  const measurement = measureApnsPayloadBudget(payload);
  if (measurement.remainingBytes < 0) {
    throw new Error(`APNs payload exceeds ${measurement.budgetBytes} UTF-8 bytes by ${-measurement.remainingBytes}`);
  }
  return measurement;
}

export const presentationActivityKitContentStateSchema = z.object({
  header: z.string().nullable(), title: z.string(), subtitle: z.string().nullable(), status: z.string(),
  componentsJson: z.string(), surfacesJson: z.string(), identityJson: z.string(), stateJson: z.string(),
  behaviorType: presentationBehaviorTypeSchema,
  primaryAction: z.enum(["approve", "yes"]).nullable(), primaryLabel: z.string().nullable(),
  secondaryAction: z.enum(["deny", "no"]).nullable(), secondaryLabel: z.string().nullable(),
  /** Present only on a choice card; phones that cannot show one never receive it. */
  choiceOptions: z.array(choiceOptionSchema).optional(),
  appearanceJson: z.string(), privacy: presentationPrivacySchema,
}).strict();
export type PresentationActivityKitContentState = z.infer<typeof presentationActivityKitContentStateSchema>;
export function projectLiveActivityPresentationToActivityKitContentState(
  input: unknown,
): PresentationActivityKitContentState {
  const presentation = projectLiveActivityPresentationPrivacy(input);
  const actions = presentation.behavior.type === "approval" || presentation.behavior.type === "yes_no"
    ? presentation.behavior : null;
  const projected = presentationActivityKitContentStateSchema.parse({
    header: presentation.content.header, title: presentation.content.title,
    subtitle: presentation.content.subtitle, status: presentation.content.status,
    componentsJson: stableJsonStringify(presentation.components),
    surfacesJson: stableJsonStringify(presentation.surfaces),
    identityJson: stableJsonStringify(presentation.identity), stateJson: stableJsonStringify(presentation.state),
    behaviorType: presentation.behavior.type, primaryAction: actions?.primary.action ?? null,
    primaryLabel: actions?.primary.label ?? null, secondaryAction: actions?.secondary.action ?? null,
    secondaryLabel: actions?.secondary.label ?? null,
    ...(presentation.behavior.type === "choice" ? { choiceOptions: presentation.behavior.options } : {}),
    appearanceJson: stableJsonStringify(presentation.appearance), privacy: presentation.privacy,
  });
  if (stableJsonByteLength(projected) > LIVE_ACTIVITY_PRESENTATION_APNS_RESERVED_ENVELOPE_BYTES) {
    throw new Error("ActivityKit presentation projection exceeds its reserved APNs envelope allocation");
  }
  return projected;
}

export const LIVE_ACTIVITY_PRESET_IDS = [
  "standard", "ring", "hero", "terminal", "steps", "approval", "shell", "verdict", "signal",
] as const;
export const liveActivityPresetIdSchema = z.enum(LIVE_ACTIVITY_PRESET_IDS);
export type LiveActivityPresetId = z.infer<typeof liveActivityPresetIdSchema>;
