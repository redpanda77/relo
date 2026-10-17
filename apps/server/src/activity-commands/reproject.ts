import { randomUUID } from "node:crypto";
import { beginActivityTransaction } from "../activity-lifecycle-domain.js";
import { effectiveComputerIcon } from "../computers/store.js";
import type { Database } from "../db.js";
import { loadClientPresentationPolicy } from "../presentation-policy.js";
import type { SubjectTransaction } from "../relevance/commands.js";
import { executeActivityCommandInTransaction } from "./commands.js";
import { taskActivityRequestHash } from "./runtime.js";
import { activityUpdateSchema,type ApnsMode } from "./schemas.js";

/**
 * The owner changed how a computer's cards look (its policy or icon). Each of its open cards is shown again
 * through the ordinary update command, so the stored card is re-resolved against the new appearance and one
 * push goes out per card, in the caller's transaction (ADR 0001). The producer declared nothing, so the update
 * is `appearanceOnly`: the card's freshness does not move. Question cards are left alone (they are not work).
 */
export async function reprojectCredentialCards(
  tx: SubjectTransaction,
  login: { principalId: string; credentialId: string; sourceName: string },
  apnsMode: ApnsMode,
): Promise<number> {
  const cards = (await tx.query<{ id: string; title: string; status: string; detail: string | null; context: Record<string,unknown> | null }>(
    `SELECT id,title,status,detail,context FROM live_activities
     WHERE principal_id=$1 AND requester_credential_id=$2 AND state='active' AND expires_at>clock_timestamp()
       AND presentation IS NOT NULL AND COALESCE(start_idempotency_key,'') NOT LIKE 'interaction:%'
     ORDER BY created_at,id`,
    [login.principalId,login.credentialId],
  )).rows;
  if (!cards.length) return 0;
  const policy = await loadClientPresentationPolicy(tx,login.principalId,login.credentialId);
  const computerIcon = await effectiveComputerIcon(tx,login.credentialId);
  let shown = 0;
  for (const card of cards) {
    // Title, status and detail are passed back as stored so the write changes only what the policy owns;
    // the stored context keeps the card on its project.
    const base = { title: card.title,status: card.status,detail: card.detail };
    const withContext = activityUpdateSchema.safeParse({ ...base,context: card.context ?? undefined });
    const parsed = withContext.success ? withContext : activityUpdateSchema.safeParse(base);
    if (!parsed.success) continue;
    const input = parsed.data;
    const { result } = await executeActivityCommandInTransaction(tx,{ kind: "credential",...login },{
      operation: "update",activityId: card.id,idempotencyKey: undefined,
      requestHash: taskActivityRequestHash("update",{ reproject: card.id,nonce: randomUUID() }),
      input,apnsMode,policy,computerIcon,appearanceOnly: true,
    });
    if (result.kind === "applied") shown += 1;
  }
  return shown;
}

/**
 * Runs a change to a computer's appearance (its policy row or its icon) and shows its open cards again in the
 * same transaction. `change` returns null when it matched nothing; then nothing is written.
 */
export async function changeAppearance<T>(
  db: Database,
  login: { principalId: string; credentialId: string },
  apnsMode: ApnsMode,
  change: (tx: SubjectTransaction) => Promise<T | null>,
): Promise<T | null> {
  const transaction = await beginActivityTransaction(db);
  try {
    const changed = await change(transaction.client);
    if (changed === null) { await transaction.rollback(); return null; }
    const name = (await transaction.client.query<{ name: string }>(
      `SELECT COALESCE(c.display_name,k.label) AS name FROM principal_api_keys k
       LEFT JOIN computers c ON c.login_key_id=k.id WHERE k.id=$1`,[login.credentialId])).rows[0]?.name;
    await reprojectCredentialCards(transaction.client,{ ...login,sourceName: name ?? "Relo CLI" },apnsMode);
    await transaction.commit();
    return changed;
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    await transaction.close();
  }
}
