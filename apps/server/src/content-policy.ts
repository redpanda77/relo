import type { Database } from "./db.js";
import { END_TO_END_REQUIRED,endToEndPolicy } from "./end-to-end-policy.js";

type Queryable = Pick<Database,"query">;

/**
 * The account's privacy promise as one read model (plan 10 M7): may content be stored readable, how long is
 * it kept, and is this server on a public address. The writers keep their modules (the end-to-end choice,
 * the retention setting the worker runs with); every producer route, doctor and the Dashboard read it here.
 * Code review rejects a readable-content decision made anywhere else (content-policy.test.ts).
 */
export type ContentPolicy = {
  encryption: { required: boolean; mode: "on" | "off" | "auto" };
  /** Hours after which ended content is deleted, as the worker last reported it; null when content is kept. */
  retentionHours: number | null;
  /** Whether the worker has reported its retention at all (a server whose worker never ran cannot say). */
  retentionKnown: boolean;
};

export async function contentPolicy(db: Queryable,principalId: string): Promise<ContentPolicy> {
  const [encryption,worker] = await Promise.all([
    endToEndPolicy(db,principalId),
    db.query<{ details: Record<string,unknown> | null }>("SELECT details FROM runtime_components WHERE component='worker'"),
  ]);
  const details = worker.rows[0]?.details ?? undefined;
  const hours = details?.retentionHours;
  return {
    encryption,
    retentionHours: typeof hours === "number" && hours > 0 ? hours : null,
    retentionKnown: details !== undefined && "retentionHours" in details,
  };
}

/** Who is sending readable content: a webhook service may be allowed to by its owner (services cannot seal). */
export type ReadableSender = { kind: "credential" } | { kind: "service"; readableAllowed: boolean };

const SERVICE_READABLE_REFUSED = {
  error: "end_to_end_required",
  message: "This account requires end-to-end encryption and this service may not send readable content. "
    + "The owner can allow it for this service (Dashboard > Connections > Webhooks, or relo services edit --readable), "
    + "or send from a computer with the relo CLI, which seals.",
} as const;

/**
 * The one readable-content decision. A producer route calls it only when the write carries readable text (each
 * producer type keeps its own detector of what that means); it answers the 409 body, or null when the write
 * may go ahead.
 */
export async function refuseReadable(db: Queryable,principalId: string,sender: ReadableSender = { kind: "credential" }) {
  if (sender.kind === "service" && sender.readableAllowed) return null;
  const { required } = await endToEndPolicy(db,principalId);
  if (!required) return null;
  return sender.kind === "service" ? SERVICE_READABLE_REFUSED : END_TO_END_REQUIRED;
}
