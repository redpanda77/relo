import type { ComputerIcon } from "@relo/notification-contracts";
import type { z } from "zod";
import type { ActivityDeliverySummary,activityEndSchema,activityUpdateSchema,ApnsMode } from "../activities.js";
import type { EffectivePresentationPolicy } from "../presentation-policy.js";
import type { serializeTaskActivity } from "./runtime.js";

/** Adapters authenticate these identities. Service secrets are represented only
 * by their hash and rechecked while the command owns its transaction. */
export type ActivityActor =
  | { kind: "owner"; principalId: string; sourceName: string }
  | { kind: "credential"; principalId: string; credentialId: string; sourceName: string }
  | { kind: "service"; principalId: string; serviceId: string; secretHash: string; sourceName: string };
export type ActivitySnapshot = ReturnType<typeof serializeTaskActivity>;
type CommandIdentity = {
  allowEmptyTargets?: true; activityId: string; idempotencyKey: string | undefined; requestHash: string; apnsMode: ApnsMode;
};
export type ActivityCommand = CommandIdentity & (
  | { operation: "update"; input: z.infer<typeof activityUpdateSchema>; policy: EffectivePresentationPolicy; computerIcon?: ComputerIcon | undefined;
      /** The owner changed how cards look, not the producer: the card is re-shown but not re-declared (freshness stays). */
      appearanceOnly?: true; ownerLease?: {idleSeconds:number;hardSeconds:number;staleSeconds:number} }
  /** stopped: the work was paused or dropped, not finished; its card keeps the step it reached. */
  | { operation: "end"; input: z.infer<typeof activityEndSchema>; stopped?: true }
);
export type ActivityCommandResult =
  | { kind: "applied" | "replayed"; activity: ActivitySnapshot; delivery: ActivityDeliverySummary; dismissAfterSeconds: number | null; projection?: Awaited<ReturnType<typeof import("./dashboard-projection.js").createDashboardActivityEvent>> }
  | { kind: "not_found" | "idempotency_conflict" | "activity_owner_conflict" | "activity_not_active" | "activity_target_unavailable" | "untargeted_terminal" }
  | { kind: "activity_terminal" | "sequence_conflict"; activity: ActivitySnapshot };

export type ActivityRow = {
  id: string; principal_id: string; requester_credential_id: string | null; requester_service_id: string | null;
  lifecycle_provider: string | null; lifecycle_run_id: string | null;
  state: "active" | "ended" | "expired" | "replaced"; sequence: string | number;
  title: string; status: string; detail: string | null; progress: number | null;
  stale_after_seconds?: number | null; stale_at: Date | null; expires_at: Date; created_at: Date; updated_at: Date;
  target_device_ids: string[] | null; presentation: unknown;
  activity_key: string | null; generation: number | string; symbol: string | null; style: string | null;
  privacy: string; accent_color: string | null; presentation_sha256: string | null;
  ended_at: Date | null; terminal_reason: string | null; terminal_actor: string | null;
  terminal_policy: string | null; terminal_transition_at: Date | null;
  context: Record<string,unknown> | null; origin_hash: string | null;
  resume_presentation?: unknown; question_fallback_at?: Date | null;
  presentation_preset_id: string | null; presentation_preset_revision: number | null;
  presentation_policy: {presetId?: string | null;presetRevision?: number | null} | null;
};
