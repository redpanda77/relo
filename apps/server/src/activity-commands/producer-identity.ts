import type { ProducerType } from "@relo/notification-contracts";

/**
 * The producer type and type-specific identity stored on a card (spec 11.1): a discriminated record,
 * never a mix of nullable columns. Only agent sessions carry a session key, the link to that
 * session's hook events. Each start path names its own type; nothing is inferred later.
 */
export type CardProducer =
  | { type: "agent_session"; sessionKey: string | null }
  | { type: "script" }
  | { type: "service" };

/** A credential (CLI or API key) start: an agent session when the CLI names the session key. */
export function credentialProducer(input: { sessionKey?: string | undefined; key?: string | undefined }): CardProducer {
  if (input.sessionKey) return { type: "agent_session",sessionKey: input.sessionKey };
  if (input.key?.startsWith("session-") && !input.key.startsWith("session-relo-")) return { type: "agent_session",sessionKey: null };
  return { type: "script" };
}

export const serviceProducer: CardProducer = { type: "service" };
/** Cards the owner starts from the Dashboard (Test Lab) declare like a script: writes only. */
export const ownerProducer: CardProducer = { type: "script" };

export function producerColumns(producer: CardProducer): { producerType: ProducerType; sessionKey: string | null } {
  return { producerType: producer.type,sessionKey: producer.type === "agent_session" ? producer.sessionKey : null };
}
