import type { ChoiceOption,SubjectVersion } from "@relo/notification-contracts";

/** What a question asks for; text is legacy and refused for new questions. */
export type QuestionKind = "approval" | "yes_no" | "text" | "choice";
/** The answers a question offers: options only on a choice. */
export type QuestionInteraction = {
  kind: QuestionKind; prompt: string; actionSeconds: number; options?: ChoiceOption[] | undefined;
};

export type InteractionActor =
  /** `ownerOverview`: a device that reads the whole account and answers the copy the asker waits on (owner-overview.ts). */
  | { kind: "device"; principalId: string; deviceId: string; ownerOverview?: boolean | undefined }
  | { kind: "credential"; principalId: string; credentialId: string }
  | { kind: "service"; principalId: string; serviceId: string }
  | { kind: "owner"; principalId: string }
  | { kind: "internal_expiry"; principalId: string };

export type ExpireCommand = { interactionId: string; eventId: string };
export type ExpiryResult = { kind: "expired" | "unchanged" | "not_found" };
export type InteractionRow = {
  id: string; principal_id: string; notification_event_id: string;
  kind: QuestionKind;
  options?: ChoiceOption[] | null;
  state: "pending" | "approved" | "denied" | "yes" | "no" | "replied" | "expired" | "canceled";
  expires_at: Date; responded_at: Date | null;
};
export type RespondCommand = {
  eventId: string; interactionId?: string | undefined;
  kind: "approve" | "deny" | "yes" | "no" | "answer" | "choose";
  value: Record<string,unknown>; idempotencyKey: string;
  expectedSubject?: SubjectVersion | undefined;
};

export type ActivityCapabilityActor = { kind: "live_activity"; deviceId: string; credential: string };
/**
 * A linked browser answering from the Dashboard (docs/ENCRYPTION-PROTOCOL.md, "Answering from a
 * linked browser"). The route admits only a browser of the signed-in account that a phone linked and
 * whose signature over the answer verifies; computers still decide whether its answer counts.
 */
export type BrowserAnswerActor = { kind: "browser"; principalId: string; browserId: string };
export type ResponseResult =
  | { kind: "accepted" | "replayed"; late?: boolean; evidenceId: string; interactionId: string; state: InteractionRow["state"]; respondedAt: Date | null }
  | { kind: "rejected"; error: "forbidden" | "not_found" | "invalid_credential" | "interaction_not_found" | "invalid_action"
      | "idempotency_conflict" | "interaction_version_mismatch" | "interaction_superseded" | "interaction_not_pending"
      | "interaction_terminal" | "interaction_expired" | "question_dismissed" | "not_asked_copy"; state?: InteractionRow["state"] };
/** Who answered: a phone or a linked browser (exactly one is set on the evidence row). */
export type Answerer = { deviceId: string; browserId?: undefined } | { deviceId?: undefined; browserId: string };
