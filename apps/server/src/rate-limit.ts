import type { Database } from "./db.js";

export type RateLimitScope = "account" | "client" | "device" | "service";

export async function consumeRateLimit(
  db: Database,
  input: { scope: RateLimitScope; id: string; family: string; limit: number },
): Promise<{ allowed: boolean; limit: number; remaining: number; retryAfterSeconds: number }> {
  const result = await db.query<{ request_count: number; retry_after_seconds: number }>(
    `WITH clock AS (
       SELECT date_trunc('minute',now()) AS window_start,
         GREATEST(1,CEIL(EXTRACT(EPOCH FROM (date_trunc('minute',now())+interval '1 minute'-now()))))::int
           AS retry_after_seconds
     ), consumed AS (
       INSERT INTO request_rate_limits(scope_kind,scope_id,family,window_started_at,request_count)
       SELECT $1,$2,$3,window_start,1 FROM clock
       ON CONFLICT (scope_kind,scope_id,family) DO UPDATE SET
         request_count=CASE
           WHEN request_rate_limits.window_started_at=EXCLUDED.window_started_at
             THEN request_rate_limits.request_count+1 ELSE 1 END,
         window_started_at=EXCLUDED.window_started_at,updated_at=now()
       RETURNING request_count
     ) SELECT consumed.request_count,clock.retry_after_seconds FROM consumed,clock`,
    [input.scope,input.id,input.family],
  );
  const count = Number(result.rows[0]?.request_count ?? input.limit+1);
  return {
    allowed: count <= input.limit,
    limit: input.limit,
    remaining: Math.max(0,input.limit-count),
    retryAfterSeconds: Number(result.rows[0]?.retry_after_seconds ?? 60),
  };
}
