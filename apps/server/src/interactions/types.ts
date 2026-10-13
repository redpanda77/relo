import type { SubjectVersion } from "@relo/notification-contracts";

export type InteractionActor =
  | { kind: "device"; principalId: string; deviceId: string }
  | { kind: "credential"; principalId: string; credentialId: string }
  | { kind: "service"; principalId: string; serviceId: string }
  | { kind: "owner"; principalId: string }
  | { kind: "internal_expiry"; principalId: string };

export type ExpireCommand = { interactionId: string; eventId: string };
export type ExpiryResult = { kind: "expired" | "unchanged" | "not_found" };
export type InteractionRow = {
  id: string; principal_id: string; notification_event_id: string;
  kind: "approval" | "yes_no" | "text";
  state: "pending" | "approved" | "denied" | "yes" | "no" | "replied" | "expired" | "canceled";
  expires_at: Date; responded_at: Date | null;
};
export type RespondCommand = {
  eventId: string; interactionId?: string | undefined;
  kind: "approve" | "deny" | "yes" | "no" | "answer";
  value: Record<string,unknown>; idempotencyKey: string;
  expectedSubject?: SubjectVersion | undefined;
};

export type ActivityCapabilityActor = { kind: "live_activity"; deviceId: string; credential: string };
export type ResponseResult =
  | { kind: "accepted" | "replayed"; evidenceId: string; interactionId: string; state: InteractionRow["state"]; respondedAt: Date | null }
  | { kind: "rejected"; error: "forbidden" | "not_found" | "invalid_credential" | "interaction_not_found" | "invalid_action"
      | "idempotency_conflict" | "interaction_version_mismatch" | "interaction_superseded" | "interaction_not_pending"
      | "interaction_terminal" | "interaction_expired"; state?: InteractionRow["state"] };
