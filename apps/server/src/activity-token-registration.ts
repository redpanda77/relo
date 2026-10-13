import type { Database } from "./db.js";

export type ActivityTokenRegistration = {
  principalId: string;deviceId: string;activityId: string;generation: number;
  nativeActivityId: string;encryptedToken: string;environment: "sandbox" | "production";
};

export async function registerActivityUpdateToken(db: Database,input: ActivityTokenRegistration): Promise<
  | { kind: "registered";generation: number;woken: number }
  | { kind: "generation_mismatch";generation: number }
  | { kind: "not_found" }
> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='250ms'");
    await client.query("SET LOCAL statement_timeout='2s'");
    const current = (await client.query<{ generation: number }>(
      `SELECT a.generation FROM live_activities a
       JOIN devices d ON d.id=$2 AND d.principal_id=a.principal_id
       WHERE a.id=$1 AND a.principal_id=$3 AND d.revoked_at IS NULL
         AND d.apns_environment=$4
         AND ($2=ANY(a.target_device_ids) OR a.target_device_ids IS NULL)
       FOR UPDATE OF a,d`,[input.activityId,input.deviceId,input.principalId,input.environment],
    )).rows[0];
    if (!current || current.generation !== input.generation) {
      await client.query("ROLLBACK");
      return current ? { kind: "generation_mismatch",generation: current.generation } : { kind: "not_found" };
    }
    const result = await client.query(
      `INSERT INTO live_activity_update_tokens(
         live_activity_id,device_id,generation,native_activity_id,token,environment,updated_at)
       SELECT a.id,$2,a.generation,$3,$4,$5,now() FROM live_activities a
       WHERE a.id=$1 AND (
         (a.state='active' AND a.expires_at>clock_timestamp()) OR EXISTS (
           SELECT 1 FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
           WHERE j.live_activity_id=a.id AND j.device_id=$2
             AND j.state IN ('pending','retry','processing') AND e.state='active'
             AND e.expires_at>clock_timestamp()
             AND e.payload#>>'{liveActivity,operation}'='end'
             AND e.payload#>>'{liveActivity,generation}'=a.generation::text
             AND e.payload#>>'{liveActivity,sequence}'=a.sequence::text
         ))
       ON CONFLICT (live_activity_id,device_id) DO UPDATE SET
         generation=EXCLUDED.generation,native_activity_id=EXCLUDED.native_activity_id,
         token=EXCLUDED.token,environment=EXCLUDED.environment,updated_at=now()
       WHERE live_activity_update_tokens.generation<=EXCLUDED.generation`,
      [input.activityId,input.deviceId,input.nativeActivityId,input.encryptedToken,input.environment],
    );
    if (!result.rowCount) { await client.query("ROLLBACK");return { kind: "not_found" }; }
    // The phone holds a token only once ActivityKit created the card: keep that as lasting proof.
    await client.query(
      `INSERT INTO live_activity_phone_evidence(live_activity_id,device_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,[input.activityId,input.deviceId]);
    const woken = await client.query(
      `UPDATE delivery_jobs j SET available_at=clock_timestamp(),updated_at=now()
       FROM notification_events e,live_activities a
       WHERE j.notification_event_id=e.id AND j.live_activity_id=a.id
         AND j.live_activity_id=$1 AND j.device_id=$2
         AND j.state IN ('pending','retry') AND j.last_error_code='activity_token_pending'
         AND e.state='active' AND (e.expires_at IS NULL OR e.expires_at>clock_timestamp())
         AND e.payload#>>'{liveActivity,generation}'=$3::text
         AND e.payload#>>'{liveActivity,sequence}'=a.sequence::text
         AND a.generation=$3::integer`,[input.activityId,input.deviceId,input.generation],
    );
    // The existing ready-job trigger publishes only after this commit.
    await client.query("COMMIT");
    return { kind: "registered",generation: input.generation,woken: woken.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK");throw error;
  } finally { client.release(); }
}
