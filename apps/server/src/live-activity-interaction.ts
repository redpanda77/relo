import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { publicId } from "./ids.js";

export type LiveActivityCredentialInput = {
  interactionId: string;
  notificationEventId: string;
  deviceId: string;
  principalId: string;
  credentialVersion: number;
  expiresAt: Date;
};

export const activityKitInteractionWireSchema = z.object({
  id: z.string().regex(/^int_[0-9a-f-]{36}$/i),
  notificationID: z.string().regex(/^ntf_[0-9a-f-]{36}$/i),
  targetDeviceID: z.string().regex(/^dev_[0-9a-f-]{36}$/i),
  accountID: z.string().regex(/^acc_[0-9a-f-]{36}$/i),
  kind: z.enum(["approval", "yes_no"]),
  state: z.enum(["pending", "approved", "denied", "yes", "no", "expired", "canceled"]),
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAtUnixSeconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export const activityKitContentStateWireSchema = z.object({
  headline: z.string(),
  detail: z.string().nullable(),
  progress: z.number().min(0).max(1).nullable(),
  status: z.string(),
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  style: z.enum(["standard","hero","terminal","steps","approval","shell","verdict","signal"]),
  symbol: z.enum(["terminal","code","build","success","warning"]),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  privacy: z.enum(["standard","private"]),
  expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  staleAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  primaryLabel: z.string().nullable(),
  secondaryLabel: z.string().nullable(),
  interaction: activityKitInteractionWireSchema.nullable(),
}).strict();

function value(secret: string, input: LiveActivityCredentialInput): string {
  return createHmac("sha256",secret)
    .update("relo:live-activity-interaction:v2\0","utf8")
    .update(input.interactionId,"utf8").update("\0","utf8")
    .update(input.notificationEventId,"utf8").update("\0","utf8")
    .update(input.deviceId,"utf8").update("\0","utf8")
    .update(input.principalId,"utf8").update("\0","utf8")
    .update(String(input.credentialVersion),"utf8").update("\0","utf8")
    .update(String(input.expiresAt.getTime()),"utf8")
    .digest("base64url");
}

export function createLiveActivityCredential(secret: string, input: LiveActivityCredentialInput): string {
  return value(secret,input);
}

export function verifyLiveActivityCredential(
  secret: string,
  supplied: string,
  input: LiveActivityCredentialInput,
): boolean {
  const expected = value(secret,input);
  const left = Buffer.from(supplied,"utf8");
  const right = Buffer.from(expected,"utf8");
  return left.length === right.length && timingSafeEqual(left,right);
}

export function projectLiveActivityCommand(
  secret: string,
  input: LiveActivityCredentialInput & {
    interactionKind: "approval" | "yes_no";
    interactionState: string;
  },
  command: Record<string,unknown>,
): Record<string,unknown> {
  return { ...command, interaction: {
    id: publicId("int",input.interactionId),
    notificationID: publicId("ntf",input.notificationEventId),
    targetDeviceID: publicId("dev",input.deviceId),
    accountID: publicId("acc",input.principalId),
    kind: input.interactionKind, state: input.interactionState,
    credential: createLiveActivityCredential(secret,input),
    expiresAtUnixSeconds: Math.floor(input.expiresAt.getTime() / 1_000),
  } };
}
