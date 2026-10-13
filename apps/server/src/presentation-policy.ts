import { createHash } from "node:crypto";
import {
  LIVE_ACTIVITY_DEFAULT_ACCENT_COLOR,
  liveActivityPresentationPolicySchema,
  type LiveActivityPresentation,
  type LiveActivityPresentationPolicy,
} from "@relo/notification-contracts";
import {
  canonicalPresentation,
  persistedPresentationColumns,
  presentationFromRow,
} from "./presentation-runtime.js";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };

export type PresentationPolicySource = "client" | "service" | "account" | "system";

export type EffectivePresentationPolicy<Source extends "client" | "service" = "client" | "service"> = {
  policy: LiveActivityPresentationPolicy;
  source: Source | "account" | "system";
};

export const SYSTEM_PRESENTATION_POLICY: LiveActivityPresentationPolicy =
  liveActivityPresentationPolicySchema.parse({
    preset: "automatic",
    theme: "system",
    symbol: "automatic",
    colorStrategy: "thread",
    accentColor: LIVE_ACTIVITY_DEFAULT_ACCENT_COLOR,
  });

export function systemPresentationPolicySnapshot(presetId: string) {
  return {
    policy: SYSTEM_PRESENTATION_POLICY,
    source: "system" as const,
    explicit: [] as string[],
    presetId,
    presetRevision: 1,
  };
}

const accentPalette = [
  "#5CE1FF",
  "#8B7CFF",
  "#D65CF0",
  "#4D8DFF",
  "#34D399",
  "#FBBF24",
  "#FF6B57",
  "#FF5CA8",
  "#2DD4E0",
  "#A78BFA",
  "#F472D0",
  "#60A5FA",
  "#4ADE80",
  "#FFD24D",
  "#FF8A5C",
  "#FF7AB6",
  "#22D3EE",
  "#B07CFF",
  "#E879F9",
  "#3B9CFF",
  "#2EE6A6",
  "#FFC53D",
  "#FF7467",
  "#6EE7F9",
] as const;

type ActivityPresentationInput = {
  title?: string | undefined;
  status?: string | undefined;
  detail?: string | null | undefined;
  progress?: number | null | undefined;
  progressLabel?: string | null | undefined;
  steps?: { labels: string[];current: number } | undefined;
  symbol?: "terminal" | "code" | "build" | "success" | "warning" | undefined;
  style?: "standard" | "ring" | "hero" | "terminal" | "steps" | undefined;
  privacy?: "standard" | "private" | undefined;
  preset?: LiveActivityPresentationPolicy["preset"] | undefined;
  theme?: LiveActivityPresentationPolicy["theme"] | undefined;
  accentColor?: string | undefined;
  key?: string | undefined;
  context?: {
    project?: string | undefined;
    threadName?: string | undefined;
    taskTitle?: string | undefined;
  } | undefined;
  origin?: { project?: string | undefined;thread?: string | undefined } | undefined;
  lifecycle?: { provider: string;runId: string } | undefined;
  presentation?: unknown;
};

// Retained as a stable internal error type while route modules are split; no supported input can
// trigger it after private presentation was removed from the contracts.
export class ActivityPrivacyPolicyError extends Error {
  readonly code = "private_activities_disabled";
}

export function applyActivityPrivacyPolicy<T extends ActivityPresentationInput>(
  input: T,
  _policy: LiveActivityPresentationPolicy,
): T {
  return input;
}

export function parsePresentationPolicy(value: unknown): LiveActivityPresentationPolicy | null {
  if (value === null || value === undefined) return null;
  const parsed = liveActivityPresentationPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function effectivePresentationPolicy<Source extends "client" | "service">(
  override: unknown,
  accountDefault: unknown,
  source: Source,
): EffectivePresentationPolicy<Source> {
  const scoped = parsePresentationPolicy(override);
  if (scoped) return { policy: scoped,source };
  const account = parsePresentationPolicy(accountDefault);
  if (account) return { policy: account,source: "account" };
  return { policy: SYSTEM_PRESENTATION_POLICY,source: "system" };
}

export async function loadClientPresentationPolicy(
  query: Queryable,
  principalId: string,
  credentialId: string,
): Promise<EffectivePresentationPolicy> {
  const result = await query.query(
    `SELECT k.live_activity_policy AS scoped_policy,p.live_activity_policy AS account_policy
     FROM principal_api_keys k JOIN owner_principals p ON p.id=k.principal_id
     WHERE k.id=$1 AND k.principal_id=$2 AND k.revoked_at IS NULL`,
    [credentialId,principalId],
  );
  const row = result.rows[0];
  return effectivePresentationPolicy(row?.scoped_policy,row?.account_policy,"client");
}

export async function loadServicePresentationPolicy(
  query: Queryable,
  service: { principal_id: string; live_activity_policy?: unknown },
): Promise<EffectivePresentationPolicy> {
  const result = await query.query(
    "SELECT live_activity_policy FROM owner_principals WHERE id=$1 AND disabled_at IS NULL",
    [service.principal_id],
  );
  return effectivePresentationPolicy(
    service.live_activity_policy,
    result.rows[0]?.live_activity_policy,
    "service",
  );
}

export async function loadAccountPresentationPolicy(
  query: Queryable,
  principalId: string,
): Promise<EffectivePresentationPolicy> {
  const result = await query.query(
    "SELECT live_activity_policy FROM owner_principals WHERE id=$1 AND disabled_at IS NULL",
    [principalId],
  );
  const account = parsePresentationPolicy(result.rows[0]?.live_activity_policy);
  return account
    ? { policy: account,source: "account" }
    : { policy: SYSTEM_PRESENTATION_POLICY,source: "system" };
}

function stableAccent(principalId: string,key: string | undefined): string {
  if (!key) return LIVE_ACTIVITY_DEFAULT_ACCENT_COLOR;
  const digest = createHash("sha256").update(`${principalId}\0${key}`,"utf8").digest();
  return accentPalette[digest[0]! % accentPalette.length]!;
}

function stableAccentIndex(principalId: string,key: string): number {
  const digest = createHash("sha256").update(`${principalId}\0${key}`,"utf8").digest();
  return digest.readUInt16BE(0) % accentPalette.length;
}

const identityLabelLimit = 48;

/** Identity labels are display text: trim to the contract instead of rejecting the activity. */
function identityLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= identityLabelLimit ? trimmed : `${trimmed.slice(0, identityLabelLimit - 1).trimEnd()}…`;
}

function generatedPresentationIdentity(
  principalId: string,
  input: ActivityPresentationInput,
  presentation: LiveActivityPresentation,
  policy: LiveActivityPresentationPolicy,
): LiveActivityPresentation["identity"] {
  // Colors key on the stable identity; labels show the human name and always fit the contract.
  const projectKey = input.origin?.project ?? input.context?.project;
  const threadKey = input.origin?.thread ?? input.context?.threadName ?? input.context?.taskTitle;
  const projectLabel = projectKey === undefined ? undefined : identityLabel(input.context?.project ?? projectKey);
  const threadLabel = threadKey === undefined ? undefined
    : identityLabel(input.context?.threadName ?? input.context?.taskTitle ?? threadKey);
  if (!projectLabel) {
    const ownerProject = presentation.identity.project?.provenance === "owner"
      ? presentation.identity.project : null;
    return ownerProject
      ? { project: ownerProject,thread: null,direct: false }
      : { project: null,thread: null,direct: true };
  }
  const projectIndex = stableAccentIndex(principalId,`project:${projectKey}`);
  let threadIndex = threadKey === undefined
    ? projectIndex
    : stableAccentIndex(principalId,`project:${projectKey}\0thread:${threadKey}`);
  if (threadLabel !== undefined && threadIndex === projectIndex) {
    threadIndex = (threadIndex + 7) % accentPalette.length;
  }
  const ownerProject = presentation.identity.project?.provenance === "owner"
    ? presentation.identity.project : null;
  const ownerThread = presentation.identity.thread?.provenance === "owner"
    ? presentation.identity.thread : null;
  return {
    project: ownerProject ?? {
      label: projectLabel,
      color: policy.colorStrategy === "fixed" ? policy.accentColor : accentPalette[projectIndex]!,
      icon: "project",
      revision: 1,provenance: "generated",
    },
    thread: threadLabel === undefined ? null : ownerThread ?? {
      label: threadLabel,color: accentPalette[threadIndex]!,icon: "thread",
      revision: 1,provenance: "generated",
    },
    direct: false,
  };
}

function generatedPresentationState(
  input: ActivityPresentationInput,
  presentation: LiveActivityPresentation,
): LiveActivityPresentation["state"] {
  const status = (input.status ?? presentation.content.status).toLowerCase();
  if (/(fail|error|blocked)/u.test(status) || input.symbol === "warning") {
    return { kind: "failed",tone: "failure",icon: "failed" };
  }
  if (/(complete|completed|finished|ended)/u.test(status)) {
    return { kind: "completed",tone: "success",icon: "completed" };
  }
  if (/(cancelled|canceled)/u.test(status)) return { kind: "cancelled",tone: "neutral",icon: "cancelled" };
  if (/(expired)/u.test(status)) return { kind: "expired",tone: "neutral",icon: "expired" };
  if (/(replaced|superseded)/u.test(status)) return { kind: "superseded",tone: "neutral",icon: "superseded" };
  if (presentation.behavior.type === "approval" || presentation.behavior.type === "yes_no") {
    return { kind: "needs_action",tone: "attention",icon: "needs_action" };
  }
  if (/(wait|queued|pending)/u.test(status)) return { kind: "waiting",tone: "waiting",icon: "waiting" };
  return { kind: "active",tone: "live",icon: "active" };
}

function semanticStyle(input: ActivityPresentationInput): "standard" | "hero" | "terminal" {
  const status = input.status?.toLowerCase() ?? "";
  if (input.symbol === "warning" || /(attention|blocked|error|failed|permission)/u.test(status)) return "hero";
  if (/(complete|completed|finished|ended|cancelled|canceled|expired|replaced)/u.test(status)) return "terminal";
  return "standard";
}

function resolvedStyle(input: ActivityPresentationInput,policy: LiveActivityPresentationPolicy): "standard" | "ring" | "hero" | "terminal" | "steps" {
  if (input.style) return input.style;
  const preset = input.preset && input.preset !== "automatic" ? input.preset : policy.preset;
  if (preset === "terminal" || preset === "steps") return preset;
  if (preset === "standard") return "standard";
  return semanticStyle(input);
}

function resolvedAccent(input: ActivityPresentationInput,policy: LiveActivityPresentationPolicy,principalId: string): string {
  if (input.accentColor) return input.accentColor;
  if (policy.colorStrategy === "fixed") return policy.accentColor;
  const key = policy.colorStrategy === "project"
    ? input.origin?.project ?? input.context?.project
    : input.origin?.thread ?? input.lifecycle?.runId ?? input.key
      ?? input.context?.taskTitle ?? input.context?.project;
  return stableAccent(principalId,key);
}

function resolvedSymbol(input: ActivityPresentationInput,policy: LiveActivityPresentationPolicy): "terminal" | "code" | "build" | "success" | "warning" {
  if (input.symbol) return input.symbol;
  if (policy.symbol !== "automatic") return policy.symbol;
  return input.lifecycle ? "code" : "terminal";
}

function resolvedPresetId(
  input: ActivityPresentationInput,
  policy: LiveActivityPresentationPolicy,
  style: "standard" | "ring" | "hero" | "terminal" | "steps",
): string {
  if (input.style) return `invocation.style.${input.style}`;
  if (input.preset && input.preset !== "automatic") return `invocation.${input.preset}`;
  if (policy.preset !== "automatic") return `policy.${policy.preset}`;
  if (style === "hero") return "system.agent.attention";
  if (style === "terminal") return "system.agent.terminal";
  if (typeof input.progress === "number") return "system.agent.measured";
  return "system.agent.informational";
}

function semanticStepsPresentation(
  input: ActivityPresentationInput,
  policy: LiveActivityPresentationPolicy,
  principalId: string,
): LiveActivityPresentation {
  const steps = input.steps!;
  const stepComponent: LiveActivityPresentation["components"][number] = {
    id: "named_steps",type: "steps",colorRole: "thread",
    items: steps.labels.map((label,index) => ({
      id: `step_${index+1}`,label,
      state: index+1 < steps.current ? "complete" : index+1 === steps.current ? "current" : "pending",
    })),
  };
  const progressComponent: LiveActivityPresentation["components"][number] | null =
    typeof input.progress === "number"
      ? {
          id: "measured_progress",
          type: "progress_bar",
          colorRole: "project",
          value: input.progress,
          label: input.progressLabel ?? null,
        }
      : null;
  const components = progressComponent ? [stepComponent,progressComponent] : [stepComponent];
  const minimalComponent = progressComponent ?? stepComponent;
  const theme = input.theme ?? policy.theme;
  const hasScopedIdentity = Boolean(input.origin?.project ?? input.context?.project);
  const identity = hasScopedIdentity ? { project: null,thread: null,direct: true } : {
    project: {
      label: "Relo",color: resolvedAccent(input,policy,principalId),icon: resolvedSymbol(input,policy),
      revision: 1,provenance: "owner" as const,
    },
    thread: null,direct: false,
  };
  const requested = canonicalPresentation({
    content: {
      header: null,title: input.title ?? "Relo activity",
      subtitle: input.detail ?? null,status: input.status ?? "In progress",
    },
    identity,
    state: { kind: "active",tone: "live",icon: "active" },
    components,
    surfaces: {
      lock_screen: components.map((component) => component.id),
      expanded_leading: [],
      expanded_trailing: progressComponent ? [progressComponent.id] : [],
      expanded_bottom: [stepComponent.id],
      compact_leading: [stepComponent.id],
      compact_trailing: progressComponent ? [progressComponent.id] : [],
      minimal: [minimalComponent.id],
    },
    behavior: { type: "progress" },
    appearance: {
      theme,
      roles: { cardIdentity: "project",componentIdentity: "thread",statusEmphasis: "state" },
    },
    privacy: input.privacy ?? "standard",
  });
  return canonicalPresentation({
    ...requested,
    identity: generatedPresentationIdentity(principalId,input,requested,policy),
    state: generatedPresentationState(input,requested),
  }) as LiveActivityPresentation;
}

function semanticPresentation(
  input: ActivityPresentationInput,
  policy: LiveActivityPresentationPolicy,
  principalId: string,
): LiveActivityPresentation {
  const style = resolvedStyle(input,policy);
  const hasScopedIdentity = Boolean(input.origin?.project ?? input.context?.project);
  const identity = hasScopedIdentity ? { project: null,thread: null,direct: true } : {
    project: {
      label: "Relo",color: resolvedAccent(input,policy,principalId),icon: resolvedSymbol(input,policy),
      revision: 1,provenance: "owner" as const,
    },
    thread: null,direct: false,
  };
  const progressComponent: LiveActivityPresentation["components"][number] | null =
    typeof input.progress === "number"
      ? {
          id: "measured_progress",
          type: "progress_bar",
          colorRole: "project",
          value: input.progress,
          label: input.progressLabel ?? null,
        }
      : null;
  const requested = canonicalPresentation({
    content: {
      header: null,
      title: input.title ?? "Relo activity",
      subtitle: input.detail ?? null,
      status: input.status ?? "In progress",
    },
    identity,
    state: { kind: "active",tone: "live",icon: "active" },
    components: progressComponent ? [progressComponent] : [],
    surfaces: {
      lock_screen: progressComponent ? [progressComponent.id] : [],
      expanded_leading: [],
      expanded_trailing: progressComponent ? [progressComponent.id] : [],
      expanded_bottom: progressComponent ? [progressComponent.id] : [],
      compact_leading: [],
      compact_trailing: progressComponent ? [progressComponent.id] : [],
      minimal: progressComponent ? [progressComponent.id] : [],
    },
    behavior: progressComponent ? { type: "progress" } : { type: "informational" },
    appearance: {
      theme: input.theme ?? (style === "terminal" && policy.theme === "system" ? "dark" : policy.theme),
      roles: { cardIdentity: "project",componentIdentity: "thread",statusEmphasis: "state" },
      ...(style === "ring" ? { progressDisplay: "ring" as const } : {}),
    },
    privacy: input.privacy ?? "standard",
  });
  return canonicalPresentation({
    ...requested,
    identity: generatedPresentationIdentity(principalId,input,requested,policy),
    state: generatedPresentationState(input,requested),
  });
}

export function resolveActivityPresentation(input: ActivityPresentationInput,inputPolicy: {
  principalId: string;
  effective: EffectivePresentationPolicy;
}) {
  const governedInput = applyActivityPrivacyPolicy(input,inputPolicy.effective.policy);
  if (governedInput.presentation) {
    const requested = canonicalPresentation(governedInput.presentation);
    const presentation = canonicalPresentation({
      ...requested,
      identity: generatedPresentationIdentity(
        inputPolicy.principalId,governedInput,requested,inputPolicy.effective.policy,
      ),
      state: generatedPresentationState(governedInput,requested),
    });
    return {
      stored: persistedPresentationColumns(presentation),
      snapshot: {
        policy: inputPolicy.effective.policy,
        source: "invocation" as const,
        explicit: ["presentation"],
        presetId: "invocation.presentation",
        presetRevision: 1,
      },
    };
  }

  const policy = inputPolicy.effective.policy;
  if (governedInput.steps) {
    const presentation = semanticStepsPresentation(
      governedInput,policy,inputPolicy.principalId,
    );
    return {
      stored: persistedPresentationColumns(presentation),
      snapshot: {
        policy,
        source: "invocation" as const,
        explicit: ["steps","progress","progressLabel"].filter(
          (field) => governedInput[field as keyof ActivityPresentationInput] !== undefined,
        ),
        presetId: "invocation.semantic-steps-progress",
        presetRevision: 1,
      },
    };
  }
  const requestedStyle = resolvedStyle(governedInput,policy);
  const presetId = resolvedPresetId(governedInput,policy,requestedStyle);
  const presentation = semanticPresentation(governedInput,policy,inputPolicy.principalId);
  const explicit = ["preset","theme","symbol","style","accentColor"]
    .filter((field) => governedInput[field as keyof ActivityPresentationInput] !== undefined)
    .filter((field) => field !== "preset" || governedInput.preset !== "automatic");
  return {
    stored: persistedPresentationColumns(presentation),
    snapshot: {
      policy,
      source: inputPolicy.effective.source,
      explicit,
      presetId,
      presetRevision: 1,
    },
  };
}

export function preserveActivePresentationPolicy(
  row: any,
  input: Partial<ActivityPresentationInput>,
  resolved: ReturnType<typeof persistedPresentationColumns>,
) {
  const layoutFields = ["preset","style"] as const;
  const replacesLayout = input.presentation !== undefined
    || layoutFields.some((field) => input[field] !== undefined);
  const current = presentationFromRow(row);
  if (replacesLayout) {
    // A new layout never silently publishes a private activity's content.
    return input.presentation !== undefined || resolved.presentation.privacy === current.privacy ? resolved
      : persistedPresentationColumns({ ...resolved.presentation,privacy: current.privacy });
  }

  const cosmeticFields = ["theme","symbol","accentColor"] as const;
  const changesAppearance = cosmeticFields.some((field) => input[field] !== undefined);
  const ownerIdentity = current.identity.project?.provenance === "owner"
    && current.identity.thread === null;
  const progress = row.lifecycle_provider && typeof input.progress === "number"
    && typeof row.progress === "number"
    ? Math.max(input.progress,row.progress)
    : input.progress;
  {
    if (input.steps) {
      const replacement = canonicalPresentation({
        ...resolved.presentation,
        content: {
          ...resolved.presentation.content,
          title: input.title ?? current.content.title,
          status: input.status ?? current.content.status,
          subtitle: input.detail === undefined ? current.content.subtitle : input.detail,
        },
        identity: current.identity.direct ? resolved.presentation.identity : current.identity,
        privacy: current.privacy,
      });
      return persistedPresentationColumns(replacement);
    }
    const normalizedCurrent = current;
    const presentation = canonicalPresentation({
      ...normalizedCurrent,
      content: {
        ...normalizedCurrent.content,
        title: input.title ?? normalizedCurrent.content.title,
        status: input.status ?? normalizedCurrent.content.status,
        subtitle: input.detail === undefined ? normalizedCurrent.content.subtitle : input.detail,
      },
      components: normalizedCurrent.components.map((component) => {
        if (component.type === "progress_bar") {
          return {
            ...component,
            ...(typeof progress === "number" ? { value: progress } : {}),
            ...(input.progressLabel !== undefined ? { label: input.progressLabel } : {}),
          };
        }
        return component;
      }),
      identity: changesAppearance && ownerIdentity
        ? resolved.presentation.identity
        : normalizedCurrent.identity,
      appearance: input.theme === undefined
        ? normalizedCurrent.appearance
        : {
            ...normalizedCurrent.appearance,
            theme: resolved.presentation.appearance.theme,
          },
      privacy: normalizedCurrent.privacy,
      state: generatedPresentationState(input,normalizedCurrent),
    });
    return persistedPresentationColumns(presentation);
  }
}
