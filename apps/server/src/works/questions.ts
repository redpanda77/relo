type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };

/**
 * A question asked on a work's card is a declared write of that work (spec 2.13, 7): the evidence
 * clock moves and the question (read through the card by derive) puts the work under Needs you.
 * It never changes the work's lifecycle, text or plan, and never ends it. Runs inside the ask's
 * transaction. Returns the work id the question attached to, or null for a card without a work.
 */
export async function recordQuestionOnWork(query: Queryable,card: { work_id?: string | null; principal_id: string },
  interactionRequestId?: string): Promise<string | null> {
  if (!card.work_id) return null;
  const touched: { rows: Array<{ id: string }> } = await query.query(`UPDATE works SET declared_at=statement_timestamp(),updated_at=statement_timestamp()
    WHERE id=$1 AND principal_id=$2 AND lifecycle IN ('open','paused') RETURNING id`,[card.work_id,card.principal_id]);
  const workId = touched.rows[0]?.id ?? null;
  if (workId && interactionRequestId) {
    await query.query("UPDATE interaction_requests SET work_id=$2 WHERE id=$1 AND work_id IS NULL",[interactionRequestId,workId]);
  }
  return workId;
}

/**
 * A question asked in an agent session (`Relo-Session-Key`) without the work's card (no phone holds
 * it, or the in-app fallback) attaches to the session's open work by work id, and moves its clock.
 */
export async function attachQuestionToSessionWork(query: Queryable,input: { principalId: string; sessionKey: string | undefined;
  interactionRequestId: string }): Promise<string | null> {
  const key = input.sessionKey?.trim();
  if (!key || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) return null;
  const work: { rows: Array<{ id: string }> } = await query.query(`UPDATE works SET declared_at=statement_timestamp(),updated_at=statement_timestamp()
    WHERE principal_id=$1 AND producer_type='agent_session' AND session_key=$2 AND lifecycle='open' RETURNING id`,[input.principalId,key]);
  const workId = work.rows[0]?.id;
  if (!workId) return null;
  await query.query("UPDATE interaction_requests SET work_id=$3 WHERE id=$1 AND principal_id=$2 AND work_id IS NULL",
    [input.interactionRequestId,input.principalId,workId]);
  return workId;
}
