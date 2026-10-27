import { choiceOptionSchema } from "@relo/notification-contracts";
import { z } from "zod";
import { OwnerClientError } from "./errors.js";
import { errorCode, failFor, readJson, type OwnerHttp } from "./http.js";
import { sha256Hex } from "./pkce.js";
import type { OwnerCrypto } from "./types.js";

export type AnswerAction = "approve" | "deny" | "yes" | "no" | "answer" | "choose";
export type QuestionKind = "approval" | "yes_no" | "text" | "choice";

export interface Question {
  notificationId: string;
  interactionId: string;
  kind: QuestionKind;
  prompt: string;
  options: { id: string; label: string }[];
  expiresAt: string;
  /** Context of the sealed question envelope, when the question is sealed and was opened here. */
  sealedContext: string | null;
}

/** NotificationResponsePolicy.supports */
export function supports(action: AnswerAction, kind: QuestionKind): boolean {
  switch (kind) {
    case "approval": return action === "approve" || action === "deny";
    case "yes_no": return action === "yes" || action === "no";
    case "text": return action === "answer";
    case "choice": return action === "choose";
  }
}

// Only what an answer needs from GET /api/inbox/:id (inbox-routes.ts:199, inboxItemResource resources.ts:347-376).
const detailSchema = z.object({
  item: z.object({
    interaction: z.object({
      id: z.string().regex(/^int_/),
      kind: z.enum(["approval", "yes_no", "text", "choice"]),
      prompt: z.string(),
      state: z.string(),
      expiresAt: z.string(),
      options: z.array(choiceOptionSchema).optional(),
    }).passthrough().nullable(),
    sealed: z.object({ content: z.object({ kind: z.string(), context: z.string() }).passthrough() }).passthrough().nullable().optional(),
  }).passthrough(),
}).passthrough();

const PROMPT_PLACEHOLDERS = new Set([
  "Private notification", "Open Relo on your iPhone to read this question.", "Encrypted question", "Open Relo on your iPhone to read this.",
]);

/** GET /api/inbox/:notificationId (device bearer). Null when it holds no pending question. */
export async function fetchQuestion(http: OwnerHttp, accessToken: string, crypto: OwnerCrypto, notificationId: string): Promise<Question | null> {
  const response = await http.request(`/api/inbox/${notificationId}`, { bearer: accessToken });
  if (response.status === 404) return null;
  if (response.status !== 200) throw failFor(response);
  const raw = await readJson(response);
  const rawDetail = detailSchema.safeParse(raw);
  if (!rawDetail.success) throw new OwnerClientError("invalid_response", 200);
  const opened = detailSchema.safeParse(await crypto.openTree(raw));
  if (!opened.success) throw new OwnerClientError("invalid_response", 200);
  const interaction = opened.data.item.interaction;
  if (!interaction || interaction.state !== "pending") return null;
  // The envelope's context is the server's copy of a value only the asking computer chose: read from the raw tree.
  const sealed = rawDetail.data.item.sealed?.content;
  const bound = sealed?.kind === "question" && !PROMPT_PLACEHOLDERS.has(interaction.prompt);
  return {
    notificationId, interactionId: interaction.id, kind: interaction.kind, prompt: interaction.prompt,
    options: interaction.options ?? [], expiresAt: interaction.expiresAt, sealedContext: bound ? sealed!.context : null,
  };
}

/** What the signature covers (ReloAnswerSigning.signedValue). */
export async function signedValue(action: AnswerAction, value: { optionId?: string; response?: string }): Promise<string> {
  if (action === "choose") return `choose:${value.optionId ?? ""}`;
  if (action === "answer") return `answer:${await sha256Hex(value.response ?? "")}`;
  return action;
}

const acceptedSchema = z.object({
  interactionId: z.string(), replayed: z.boolean(),
  decision: z.object({ id: z.string(), state: z.string(), respondedAt: z.string() }).passthrough(),
}).passthrough();
export type Decision = z.infer<typeof acceptedSchema>["decision"];

/** Why the server refused an answer (409 bodies, interaction-routes.ts:376-378). */
export type Rejection = "superseded" | "version_mismatch" | "expired" | "answered" | "not_asked_copy" | "unavailable";

export interface AnswerInput {
  http: OwnerHttp;
  crypto: OwnerCrypto;
  credential: { deviceId: string; accessToken: string; installationId: string };
  question: Question;
  action: AnswerAction;
  optionId?: string;
  response?: string;
  now: () => number;
}

/**
 * POST /api/notifications/:id/interactions, device bearer, body {kind, value, idempotencyKey, expectedInteractionId}
 * (schemas.ts:113, interaction-routes.ts:364). The value carries this device's signature (e2ee* fields,
 * answerSignatureSchema sealed-content.ts:81) over {interaction, notification, device, value, respondedAt}, bound to the
 * sealed question's context when there is one. The key is stable per question+action, so a retry is a replay.
 */
export async function submitAnswer(input: AnswerInput): Promise<Decision> {
  const { question, action } = input;
  if (!supports(action, question.kind)) throw new OwnerClientError("rejected", undefined, "unsupported_action");
  if (action === "choose" && !question.options.some((o) => o.id === input.optionId)) throw new OwnerClientError("rejected", undefined, "unknown_option");
  if (action === "answer" && !(input.response ?? "").trim()) throw new OwnerClientError("rejected", undefined, "empty_response");
  if (Date.parse(question.expiresAt) <= input.now()) throw new OwnerClientError("rejected", undefined, "expired");

  const value: Record<string, string> = action === "choose" ? { optionId: input.optionId! } : action === "answer" ? { response: input.response! } : {};
  const respondedAt = new Date(input.now()).toISOString();
  const signature = await input.crypto.signAnswer({
    interactionId: question.interactionId, notificationId: question.notificationId, deviceId: input.credential.deviceId,
    value: await signedValue(action, value), respondedAt,
    ...(question.sealedContext ? { question: question.sealedContext } : {}),
  });
  if (signature) {
    value.e2eeKeyId = signature.keyId;
    value.e2eeSignedAt = respondedAt;
    value.e2eeSignature = signature.signature;
    if (question.sealedContext && signature.questionSignature) {
      value.e2eeQuestion = question.sealedContext;
      value.e2eeQuestionSignature = signature.questionSignature;
    }
  }
  const idempotencyKey = `win:${input.credential.installationId}:${question.notificationId}:${action}${input.optionId ? `:${input.optionId}` : ""}`;
  const response = await input.http.request(`/api/notifications/${question.notificationId}/interactions`, {
    method: "POST", bearer: input.credential.accessToken, timeoutMs: 5_000,
    body: { kind: action, value, idempotencyKey, expectedInteractionId: question.interactionId },
  });
  if (response.status === 200 || response.status === 201) {
    const parsed = acceptedSchema.safeParse(await readJson(response));
    if (!parsed.success) throw new OwnerClientError("invalid_response", response.status);
    return parsed.data.decision;
  }
  const code = await errorCode(response);
  if (response.status === 400) throw new OwnerClientError("invalid_request", 400, code);
  if (response.status === 401 || response.status === 403) throw new OwnerClientError("unauthorized", response.status, code);
  if (response.status === 404) throw new OwnerClientError("rejected", 404, "unavailable");
  if (response.status === 409) {
    const reason: Record<string, Rejection> = {
      interaction_superseded: "superseded", interaction_version_mismatch: "version_mismatch",
      interaction_not_pending: "answered", not_asked_copy: "not_asked_copy",
    };
    if (code && reason[code]) throw new OwnerClientError("rejected", 409, reason[code]);
    throw new OwnerClientError("conflict", 409, code);
  }
  if (response.status === 429) throw new OwnerClientError("rate_limited", 429, code);
  throw new OwnerClientError("unavailable", response.status, code);
}

/**
 * POST /api/devices/self/questions/:interactionId/dismiss, device bearer (interaction-routes.ts:355): the owner has seen a
 * missed question and it leaves Needs you. 404 means it is already gone, which is the same outcome.
 */
export async function dismissMissedQuestion(http: OwnerHttp, accessToken: string, interactionId: string): Promise<void> {
  if (!/^int_[A-Za-z0-9_-]+$/.test(interactionId)) throw new OwnerClientError("rejected", undefined, "unknown_question");
  const response = await http.request(`/api/devices/self/questions/${interactionId}/dismiss`, { method: "POST", bearer: accessToken, timeoutMs: 5_000 });
  if (response.status === 200 || response.status === 204 || response.status === 404) return;
  throw failFor(response);
}
