import { createHash } from "node:crypto";
import {
  parseLiveActivityPresentation,
  presentationActivityKitContentStateSchema,
  projectLiveActivityPresentationPrivacy,
  projectLiveActivityPresentationToActivityKitContentState,
  stableSerializeLiveActivityPresentation,
  type LiveActivityPresentation,
  type PresentationActivityKitContentState,
} from "@relo/notification-contracts";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };

const DATABASE_SYMBOLS = new Set(["terminal", "code", "build", "success", "warning"]);

export class PresentationRuntimeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PresentationRuntimeError";
  }
}

export function canonicalPresentation(input: unknown): LiveActivityPresentation {
  const presentation = parseLiveActivityPresentation(input);
  return projectLiveActivityPresentationPrivacy(presentation);
}

export function presentationFromRow(row: any): LiveActivityPresentation {
  if (!row.presentation) throw new PresentationRuntimeError("presentation_missing");
  const presentation = canonicalPresentation(row.presentation);
  if (row.presentation_sha256) {
    const actual = createHash("sha256")
      .update(stableSerializeLiveActivityPresentation(presentation),"utf8").digest("hex");
    if (actual !== row.presentation_sha256) {
      throw new PresentationRuntimeError("presentation_integrity_failed");
    }
  }
  return presentation;
}

function progressValue(presentation: LiveActivityPresentation): number | null {
  const component = presentation.components.find((candidate) => candidate.type === "progress_bar")
    ?? presentation.components.find((candidate) => candidate.type === "steps");
  if (!component) return null;
  if (component.type === "progress_bar") return component.value;
  return component.items.filter((item) => item.state === "complete").length / component.items.length;
}

function databaseSymbol(presentation: LiveActivityPresentation):
  "terminal" | "code" | "build" | "success" | "warning" {
  const icon = presentation.state.icon;
  if (DATABASE_SYMBOLS.has(icon)) return icon as ReturnType<typeof databaseSymbol>;
  const identityIcon = presentation.identity.project?.icon;
  if (identityIcon && DATABASE_SYMBOLS.has(identityIcon)) {
    return identityIcon as ReturnType<typeof databaseSymbol>;
  }
  if (presentation.state.kind === "completed") return "success";
  if (["failed","cancelled","expired"].includes(presentation.state.kind)) return "warning";
  if (presentation.identity.project !== null || presentation.identity.thread !== null) return "build";
  return "terminal";
}

function databaseStyle(presentation: LiveActivityPresentation): string {
  if (presentation.behavior.type === "approval") return "approval";
  if (presentation.behavior.type === "yes_no") return "verdict";
  if (presentation.components.some((component) => component.type === "steps")) return "steps";
  if (presentation.appearance.progressDisplay === "ring") return "ring";
  return presentation.appearance.theme === "dark" ? "terminal" : "standard";
}

function presentationAccent(presentation: LiveActivityPresentation): string {
  const role = presentation.appearance.roles.cardIdentity;
  if (role === "thread") return presentation.identity.thread?.color
    ?? presentation.identity.project?.color ?? "#5ED8B7";
  if (role === "project") return presentation.identity.project?.color ?? "#5ED8B7";
  if (role === "state") {
    if (presentation.state.tone === "success") return "#5ED8B7";
    if (presentation.state.tone === "failure") return "#FF7A90";
    if (presentation.state.tone === "attention") return "#F2A65A";
    if (presentation.state.tone === "waiting") return "#E2C45B";
  }
  return "#5ED8B7";
}

export type PersistedPresentationColumns = {
  presentation: LiveActivityPresentation;
  presentationHash: string;
  title: string;
  status: string;
  detail: string | null;
  progress: number | null;
  symbol: "terminal" | "code" | "build" | "success" | "warning";
  style: string;
  privacy: "standard" | "private";
  accentColor: string;
};

export function persistedPresentationColumns(presentationInput: unknown): PersistedPresentationColumns {
  const presentation = canonicalPresentation(presentationInput);
  const presentationHash = createHash("sha256")
    .update(stableSerializeLiveActivityPresentation(presentation),"utf8").digest("hex");
  return {
    presentation,
    presentationHash,
    title: presentation.content.title,
    status: presentation.content.status,
    detail: presentation.content.subtitle,
    progress: progressValue(presentation),
    symbol: databaseSymbol(presentation),
    style: databaseStyle(presentation),
    privacy: presentation.privacy,
    accentColor: presentationAccent(presentation),
  };
}

export function patchPresentationColumns(row: any, patch: {
  title?: string | undefined;
  status?: string | undefined;
  detail?: string | null | undefined;
  progress?: number | null | undefined;
  progressLabel?: string | null | undefined;
}): PersistedPresentationColumns {
  const current = presentationFromRow(row);
  const presentation = canonicalPresentation({
    ...current,
    content: {
      ...current.content,
      title: patch.title ?? current.content.title,
      status: patch.status ?? current.content.status,
      subtitle: patch.detail === undefined ? current.content.subtitle : patch.detail,
    },
    components: current.components.map((component) => {
      if (component.type !== "progress_bar") return component;
      return {
        ...component,
        ...(typeof patch.progress === "number" ? { value: patch.progress } : {}),
        ...(patch.progressLabel !== undefined ? { label: patch.progressLabel } : {}),
      };
    }),
  });
  return persistedPresentationColumns(presentation);
}

export function terminalPresentationFromRow(
  row: any,
  status: string,
  symbol: "success" | "warning",
  patch: {
    detail?: string | null | undefined;
    progress?: number | null | undefined;
    accentColor?: string | undefined;
    /** The work itself finished: on success, steps complete and a measured bar fills. */
    workFinished?: boolean | undefined;
  } = {},
): LiveActivityPresentation {
  const current = presentationFromRow(row);
  const interactive = current.behavior.type === "approval" || current.behavior.type === "yes_no";
  const progressComponentIds = new Set(current.components
    .filter((component) => component.type === "progress_bar")
    .map((component) => component.id));
  const existingComponentIds = new Set(current.components.map((component) => component.id));
  let addedProgressId = "terminal_progress";
  for (let suffix = 2; existingComponentIds.has(addedProgressId); suffix += 1) {
    addedProgressId = `terminal_progress_${suffix}`;
  }
  const finished = patch.workFinished === true && symbol === "success";
  const rawComponents = patch.progress === null
    ? current.components.filter((component) => component.type !== "progress_bar")
    : [
        ...current.components.map((component) => component.type === "progress_bar"
          && typeof patch.progress === "number"
          ? { ...component,value: patch.progress }
          : component),
        ...(typeof patch.progress === "number" && progressComponentIds.size === 0
          ? [{
              id: addedProgressId,type: "progress_bar" as const,colorRole: "project" as const,
              value: patch.progress,label: null,
            }]
          : []),
      ];
  // A finished card shows finished progress; a stopped one keeps exactly where the work stopped.
  const components = finished
    ? rawComponents.map((component) => component.type === "steps"
      ? { ...component,items: component.items.map((item) => ({ ...item,state: "complete" as const })) }
      : component.type === "progress_bar" && typeof patch.progress !== "number"
        ? { ...component,value: 1 }
        : component)
    : rawComponents;
  const surfaces = patch.progress === null
    ? Object.fromEntries(Object.entries(current.surfaces).map(([surface,componentIds]) => [
        surface,componentIds.filter((componentId) => !progressComponentIds.has(componentId)),
      ])) as LiveActivityPresentation["surfaces"]
    : typeof patch.progress === "number" && progressComponentIds.size === 0
      ? {
          ...current.surfaces,
          lock_screen: [...current.surfaces.lock_screen,addedProgressId],
          expanded_bottom: [...current.surfaces.expanded_bottom,addedProgressId],
          compact_trailing: [...current.surfaces.compact_trailing,addedProgressId],
          minimal: current.surfaces.minimal.length === 0 ? [addedProgressId] : current.surfaces.minimal,
        }
    : current.surfaces;
  const cardIdentity = current.appearance.roles.cardIdentity;
  const identity = patch.accentColor === undefined ? current.identity : {
    ...current.identity,
    project: current.identity.project === null ? null : {
      ...current.identity.project,
      color: cardIdentity === "project" ? patch.accentColor : current.identity.project.color,
    },
    thread: current.identity.thread === null ? null : {
      ...current.identity.thread,
      color: cardIdentity === "thread" ? patch.accentColor : current.identity.thread.color,
    },
  };
  return canonicalPresentation({
    ...current,
    content: {
      ...current.content,status,
      subtitle: patch.detail === undefined ? current.content.subtitle : patch.detail,
    },
    identity,
    components,
    surfaces,
    behavior: interactive || patch.progress === null
      ? { type: "informational" as const }
      : current.behavior,
    state: symbol === "success"
      ? { kind: "completed" as const,tone: "success" as const,icon: "completed" as const }
      : { kind: "failed" as const,tone: "failure" as const,icon: "failed" as const },
  });
}

export function terminalPresentationColumnsFromRow(
  row: any,
  status: string,
  symbol: "success" | "warning",
  patch: {
    detail?: string | null | undefined;
    progress?: number | null | undefined;
    accentColor?: string | undefined;
    workFinished?: boolean | undefined;
  } = {},
): PersistedPresentationColumns {
  return persistedPresentationColumns(terminalPresentationFromRow(row,status,symbol,patch));
}

export function presentationRequestIdentity(presentation: unknown): string {
  return stableSerializeLiveActivityPresentation(canonicalPresentation(presentation));
}

export async function assertAccountPresentationAssets(
  query: Queryable,
  principalId: string,
  presentationInput: unknown,
): Promise<void> {
  const assets = canonicalPresentation(presentationInput).components
    .filter((component) => component.type === "image").map((component) => component.asset);
  for (const asset of assets) {
    const result = await query.query(
      `SELECT asset_id,revision,sha256,media_type,byte_size,pixel_width,pixel_height
       FROM presentation_assets
       WHERE principal_id=$1 AND asset_id=$2 AND deleted_at IS NULL`,
      [principalId,asset.assetId],
    );
    if (!result.rowCount) throw new PresentationRuntimeError("asset_not_found");
    const row = result.rows[0]!;
    const exact = Number(row.revision) === asset.revision
      && row.sha256 === asset.sha256
      && row.media_type === asset.mediaType
      && Number(row.byte_size) === asset.byteSize
      && Number(row.pixel_width) === asset.pixelWidth
      && Number(row.pixel_height) === asset.pixelHeight;
    if (!exact) throw new PresentationRuntimeError("asset_reference_mismatch");
  }
}

export function presentationCommandProjection(input: unknown): PresentationActivityKitContentState {
  return projectLiveActivityPresentationToActivityKitContentState(canonicalPresentation(input));
}

export function presentationCommandState(
  command: Record<string,unknown>,
): PresentationActivityKitContentState | null {
  const shape = presentationActivityKitContentStateSchema.shape;
  const candidate = Object.fromEntries(Object.keys(shape).map((key) => [key,command[key]]));
  const parsed = presentationActivityKitContentStateSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function parsePersistedPresentation(input: unknown): LiveActivityPresentation {
  return parseLiveActivityPresentation(input);
}
