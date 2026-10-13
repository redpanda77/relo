import { createHash,randomUUID } from "node:crypto";
import { prepareNotificationContent,type NotificationContentCipher } from "../notification-content.js";
import { createNotificationInTransaction } from "../notifications/commands.js";
import type { SubjectTransaction } from "../relevance/commands.js";
import type { FoldQuestionInput } from "./fold-question.js";
import type { ApnsMode } from "./schemas.js";

/**
 * A question folded onto a card can wait no longer than the card lives (8 hours on iOS). When it
 * should wait longer, the same decision continues as a quiet notification in Relo's Needs you: the
 * card already alerted. Answering either one decides (decision group). Returns the request that
 * waits longest, which the asker follows.
 */
export async function continueQuestionBeyondCard(client: SubjectTransaction,input: {
  principalId: string; credentialId: string; card: any; question: FoldQuestionInput; idempotencyKey: string;
  sourceName: string; apnsMode: ApnsMode; contentCipher: NotificationContentCipher;
}): Promise<string> {
  const { card,question } = input;
  const copies = (await client.query<{ id: string }>(
    `SELECT r.id FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id
     WHERE e.principal_id=$1 AND e.idempotency_key LIKE $2`,
    [input.principalId,`activity:${card.id}:${card.sequence}:update:%`],
  )).rows.map((row) => row.id);
  const key = `${input.idempotencyKey}:waits`;
  const created = await createNotificationInTransaction(client,
    { kind: "credential",principalId: input.principalId,credentialId: input.credentialId },{
      idempotencyKey: key,requestHash: createHash("sha256").update(key).digest("hex"),
      sourceName: input.sourceName,title: card.title,
      content: prepareNotificationContent(question.detail
        ? { body: `${question.prompt}\n\n${question.detail}`,summary: question.prompt,bodyFormat: "markdown" }
        : { body: question.prompt }),
      imageUrl: null,deepLink: null,payload: { context: card.context ?? {} },
      deviceIds: card.target_device_ids,originHash: null,quiet: true,
      interaction: { kind: question.type,prompt: question.prompt,actionSeconds: question.expiresInSeconds,
        options: question.options },
    },{ apnsMode: input.apnsMode,contentCipher: input.contentCipher });
  if (created.kind !== "created" || !created.interaction) throw new Error("long_question_persistence_failed");
  await client.query("UPDATE interaction_requests SET decision_group_id=$1 WHERE id=ANY($2::uuid[])",
    [randomUUID(),[...copies,created.interaction.id]]);
  return created.interaction.id;
}
