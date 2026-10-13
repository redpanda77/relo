import { createHash } from "node:crypto";
import { safeContextSchema } from "@relo/notification-contracts";
import type { z } from "zod";
import type { OriginDescriptor } from "./origin-slots.js";

/** The bounded semantic context accepted on producer requests. */
export type WorkContext = z.infer<typeof safeContextSchema>;

export type WorkIdentityResult =
  | { ok: true; context: WorkContext }
  | { ok: false; missing: ("project" | "topic")[] };

/**
 * Every new notification, standalone decision, and Live Activity must name its project and topic
 * (source is the authenticated producer). Mirrors the CLI rule: an explicit context value wins,
 * otherwise the origin descriptor supplies it. A topic without a provider thread or origin gets a
 * stable correlation key so repeated sends group into one conversation.
 */
/**
 * Generic fillers that satisfy "non-empty" without identifying anything. A producer that cannot
 * name its project or topic must say so (422) rather than file work under a shared placeholder.
 */
const placeholderProjects = new Set(["project", "codex work", "default", "unknown", "none", "n/a", "untitled"]);
const placeholderTopics = new Set([
  "topic", "task", "codex task", "completion", "unnamed topic", "default", "unknown", "none", "n/a", "untitled",
]);

function meaningful(value: string | undefined, placeholders: Set<string>) {
  const trimmed = value?.trim();
  return trimmed && !placeholders.has(trimmed.toLowerCase()) ? trimmed : undefined;
}

export function requireWorkIdentity(
  sourceName: string,
  context: WorkContext | undefined,
  origin: OriginDescriptor | undefined,
): WorkIdentityResult {
  const project = meaningful(context?.project, placeholderProjects) ?? meaningful(origin?.project, placeholderProjects);
  const topic = meaningful(context?.threadName, placeholderTopics) ?? meaningful(origin?.thread, placeholderTopics);
  const missing: ("project" | "topic")[] = [];
  if (!project) missing.push("project");
  if (!topic) missing.push("topic");
  if (!project || !topic) {
    // Producers fail silently when a hook swallows the 422; the server log is the record.
    console.warn(JSON.stringify({ event: "work_identity_rejected", producer: sourceName, missing }));
    return { ok: false, missing };
  }
  const normalized: WorkContext = { ...context, project, threadName: topic };
  if (normalized.providerThreadId === undefined && origin === undefined) {
    normalized.providerThreadId = `topic:${createHash("sha256")
      .update(JSON.stringify([sourceName, project, topic])).digest("hex")}`;
  }
  return { ok: true, context: normalized };
}

export function workIdentityError(missing: ("project" | "topic")[]) {
  return {
    error: "work_identity_required",
    missing,
    message: "Every new notification, decision, and Live Activity needs a real project and topic "
      + "(generic placeholders such as \"Project\" or \"Codex task\" are rejected): send "
      + "context.project and context.threadName, or an origin descriptor.",
    hint: "CLI: relo notify send \"…\" --source \"Codex\" --project \"<repository>\" --topic \"<what this work is about>\"",
  };
}
