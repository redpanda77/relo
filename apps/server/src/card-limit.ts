type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

/** The owner's cap on open cards for one CLI login, when this login is already at it. */
export async function cardLimitReached(query: Queryable,credentialId: string | null): Promise<number | null> {
  if (!credentialId) return null;
  const row = (await query.query(
    `SELECT k.max_active_cards,(SELECT count(*)::int FROM live_activities a
       WHERE a.requester_credential_id=k.id AND a.state='active' AND a.expires_at>clock_timestamp()) AS open
     FROM principal_api_keys k WHERE k.id=$1`,[credentialId])).rows[0];
  const cap = row?.max_active_cards;
  return cap != null && row.open >= cap ? cap : null;
}

export const cardLimitBody = (cap: number) => ({
  error: "card_limit_reached",code: "CARD_LIMIT_REACHED",
  message: `This login keeps at most ${cap} open card${cap === 1 ? "" : "s"}; end one first or ask with --notification-only.`,
});
