import type { Database } from "../db.js";
import { publicId } from "../ids.js";

type Queryable = Pick<Database,"query">;

/** A hooks credential as the Connections page lists it. */
export type ComputerHook = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null };

export type ComputerFacts = {
  /** Harnesses (claude-code, codex, …) with a work on this computer in the last 30 days. */
  tools: string[];
  /** Open cards this computer's login holds right now (same rule as the card limit). */
  openCards: number;
  /** The latest use of the login or any of its hooks credentials. */
  lastSeenAt: string | null;
  hooks: ComputerHook[];
  encryption: "encrypts" | "no_keys";
};

/**
 * The one definition of a computer's last-seen time: the latest use of its login or any of its live hooks
 * credentials. A scalar SQL expression over the computers row aliased `alias`; null when never used.
 */
export const computerLastSeenSql = (alias: string): string =>
  `GREATEST((SELECT pk.last_used_at FROM principal_api_keys pk WHERE pk.id=${alias}.login_key_id),
    (SELECT max(hc.last_used_at) FROM harness_credentials hc WHERE hc.computer_id=${alias}.id AND hc.revoked_at IS NULL))`;

const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);

/**
 * What the Connections page shows about each computer beyond its stored row, in one statement (lateral
 * subqueries, never a query per computer). Keys are internal computer ids.
 */
export async function computerFacts(db: Queryable,computerIds: string[]): Promise<Map<string,ComputerFacts>> {
  const facts = new Map<string,ComputerFacts>();
  if (computerIds.length === 0) return facts;
  const result = await db.query<any>(
    `SELECT c.id,COALESCE(t.tools,'{}') AS tools,COALESCE(o.open_cards,0) AS open_cards,
       ${computerLastSeenSql("c")} AS last_seen_at,COALESCE(h.hooks,'[]'::jsonb) AS hooks,
       e.api_key_id IS NOT NULL AS has_keys
     FROM computers c
     JOIN principal_api_keys k ON k.id=c.login_key_id
     LEFT JOIN client_identity_keys e ON e.api_key_id=k.id
     LEFT JOIN LATERAL (
       SELECT array_agg(DISTINCT w.harness ORDER BY w.harness) AS tools FROM works w
       WHERE w.credential_id=c.login_key_id AND w.harness IS NOT NULL AND w.updated_at>now()-interval '30 days'
     ) t ON true
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS open_cards FROM live_activities a
       WHERE a.requester_credential_id=c.login_key_id AND a.state='active' AND a.expires_at>clock_timestamp()
     ) o ON true
     LEFT JOIN LATERAL (
       SELECT max(last_used_at) AS last_used,
         jsonb_agg(jsonb_build_object('id',id,'name',name,'prefix',token_prefix,'createdAt',created_at,'lastUsedAt',last_used_at)
           ORDER BY created_at DESC,id DESC) AS hooks
       FROM harness_credentials WHERE computer_id=c.id AND revoked_at IS NULL
     ) h ON true
     WHERE c.id=ANY($1::uuid[])`,
    [computerIds],
  );
  for (const row of result.rows) {
    facts.set(row.id,{
      tools: row.tools,
      openCards: Number(row.open_cards),
      lastSeenAt: iso(row.last_seen_at),
      hooks: (row.hooks as any[]).map((hook) => ({
        id: publicId("hck",hook.id),name: hook.name,prefix: hook.prefix,
        createdAt: iso(hook.createdAt)!,lastUsedAt: iso(hook.lastUsedAt),
      })),
      encryption: row.has_keys ? "encrypts" : "no_keys",
    });
  }
  return facts;
}

/**
 * Hooks credentials that show under no computer: minted before computers existed or by a login that was
 * revoked since (revoking a login does not revoke its hooks). The Dashboard lists them apart.
 */
export async function unlinkedHooks(db: Queryable,principalId: string,limit: number): Promise<ComputerHook[]> {
  const result = await db.query<any>(
    `SELECT h.id,h.name,h.token_prefix,h.created_at,h.last_used_at FROM harness_credentials h
     LEFT JOIN computers c ON c.id=h.computer_id
     LEFT JOIN principal_api_keys k ON k.id=c.login_key_id
     WHERE h.principal_id=$1 AND h.revoked_at IS NULL
       AND (k.id IS NULL OR k.revoked_at IS NOT NULL OR (k.expires_at IS NOT NULL AND k.expires_at<=now()))
     ORDER BY h.created_at DESC,h.id DESC LIMIT $2`,
    [principalId,limit],
  );
  return result.rows.map((row) => ({
    id: publicId("hck",row.id),name: row.name,prefix: row.token_prefix,
    createdAt: iso(row.created_at)!,lastUsedAt: iso(row.last_used_at),
  }));
}
