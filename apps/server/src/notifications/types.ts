import type { RelevanceItem } from "@relo/notification-contracts";
import type { QuestionInteraction } from "../interactions/types.js";
import type { ApnsMode } from "../activities.js";
import type { PreparedNotificationContent,NotificationContentCipher } from "../notification-content.js";
import type { SubjectCommand } from "../relevance/commands.js";

/** Authentication and transport policy belong to adapters. Never construct an
 * actor from notification payload fields or infer ownership from a display name. */
export type NotificationActor =
  | { kind: "credential"; principalId: string; credentialId: string }
  | { kind: "service"; principalId: string; serviceId: string }
  | { kind: "owner"; principalId: string };

export type WithdrawNotificationCommand = { eventId: string; idempotencyKey: string };
export type WithdrawNotificationResult =
  | { kind: "not_found" }
  | { kind: "withdrawn"; eventId: string; withdrawnAt: Date; replayed: true }
  | { kind: "withdrawn"; eventId: string; withdrawnAt: Date; replayed: false; canceledDeliveries: number };

/** `readers`: active owner overview devices (the Mac) that show it from Now; they are never push targets (owner-overview.ts). */
export type DeliverySummary = { eligibleDevices: number; durableCommands: number; apnsJobs: number; readers?: number | undefined };
export type CreateNotificationCommand = {
  idempotencyKey: string; requestHash: string;
  sourceName: string; title: string; content: PreparedNotificationContent;
  imageUrl: string | null; deepLink: string | null; avatarUrl?: string | null | undefined;
  payload: Record<string,unknown>; deviceIds: string[] | null; originHash: string | null;
  relevance?: SubjectCommand | undefined;
  interaction?: (QuestionInteraction & { actionDeadlineCap?: Date | string | undefined }) | undefined;
  /** Stored and shown in Relo without an alert: another surface of the same decision already alerted. */
  quiet?: boolean | undefined;
};
export type NotificationDependencies = { apnsMode: ApnsMode; contentCipher: NotificationContentCipher | null };
export type NotificationReceipt = {
  eventId: string; createdAt: Date; delivery: DeliverySummary; relevance: RelevanceItem | null;
  interaction: { id: string; state: string; expiresAt: Date } | null;
};
export type CreateNotificationResult =
  | { kind: "invalid_device_selection" }
  | { kind: "idempotency_conflict" }
  | ({ kind: "created" | "replayed" } & NotificationReceipt);
