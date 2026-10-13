import { createHash } from "node:crypto";
import { relevanceDeliveryGuard } from "./relevance/delivery.js";
import type pg from "pg";
import type {
  ApnsEnvironment,
  DispatchRecipient,
  RecipientResolver,
  ResolvedRecipient,
} from "./apns-provider-cleanroom.js";
import type { Database } from "./db.js";
import {
  clearTransportTokenIfUnchanged,
  type StoredTransportToken,
  type TransportTokenEncryption,
  type TransportTokenPurpose,
} from "./token-encryption.js";

export type ApnsRecipientKind = "notification" | "live_activity_start" | "live_activity_update";

export type PostgresRecipientResolverOptions = {
  db: Database;
  encryption: TransportTokenEncryption;
  kind: ApnsRecipientKind;
  deliveryJobId: string;
  claimToken: string;
  principalId: string;
  deviceId: string;
  notificationEventId: string;
  environment: ApnsEnvironment;
  liveActivityId?: string;
  liveActivityGeneration?: number;
};

type TokenRow = {
  ciphertext: string;
  environment: ApnsEnvironment;
};

type Queryable = Pick<pg.PoolClient, "query">;

export class PostgresApnsRecipientResolver implements RecipientResolver {
  readonly invalidations: Array<{ generation: string; invalidatedAtMs?: number }> = [];

  constructor(private readonly options: PostgresRecipientResolverOptions) {
    if (options.kind === "live_activity_update" && !options.liveActivityId) {
      throw new Error("liveActivityId is required for an ActivityKit update-token resolver");
    }
    if (options.kind === "live_activity_update"
      && (!Number.isSafeInteger(options.liveActivityGeneration) || options.liveActivityGeneration! <= 0)) {
      throw new Error("liveActivityGeneration is required for an ActivityKit update-token resolver");
    }
  }

  async resolve(): Promise<ResolvedRecipient | null> {
    const row = await this.select(this.options.db, false);
    return row ? this.resolved(row) : null;
  }

  async acquire(): Promise<DispatchRecipient | null> {
    const client = await this.options.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='250ms'");
      await client.query("SET LOCAL statement_timeout='2s'");
      const row = await this.select(client, true);
      if (!row) {
        await client.query("ROLLBACK");
        return null;
      }
      const resolved = this.resolved(row);
      const stored = this.storedToken(row.ciphertext);
      // Authorization and revocation serialize here. Network work starts only
      // after commit; the returned value owns no transaction or connection.
      const fenced = await client.query(
        `UPDATE delivery_jobs SET recipient_authorized_at=clock_timestamp(),recipient_generation=$3
         WHERE id=$1 AND claim_token=$2 AND state='processing' AND claim_phase='dispatch_started'`,
        [this.options.deliveryJobId,this.options.claimToken,resolved.generation],
      );
      if (fenced.rowCount !== 1) throw new Error("APNs recipient authorization lost its delivery claim");
      await client.query("COMMIT");
      let released = false;
      return {
        ...resolved,
        invalidate: async (details) => {
          if (released) throw new Error("APNs recipient snapshot is already released");
          if (details.environment !== this.options.environment) {
            throw new Error("APNs invalidation environment does not match the authorized recipient");
          }
          await this.invalidateSnapshot(stored,resolved.generation,details);
        },
        release: async () => {
          released = true;
        },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async invalidateSnapshot(
    stored: StoredTransportToken,
    expectedGeneration: string,
    details: { invalidatedAtMs?: number },
  ): Promise<void> {
    const client = await this.options.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='250ms'");
      await client.query("SET LOCAL statement_timeout='2s'");
      const cleared = await clearTransportTokenIfUnchanged(client,stored);
      await client.query("COMMIT");
      // A replacement token surviving old feedback is a successful no-op.
      if (cleared) this.invalidations.push({
        generation: expectedGeneration,
        ...(details.invalidatedAtMs === undefined ? {} : { invalidatedAtMs: details.invalidatedAtMs }),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async invalidate(
    expectedGeneration: string,
    details: { environment: ApnsEnvironment; invalidatedAtMs?: number },
  ): Promise<void> {
    const client = await this.options.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='250ms'");
      await client.query("SET LOCAL statement_timeout='2s'");
      const row = await this.select(client, true);
      if (row && generation(row.ciphertext) === expectedGeneration) {
        if (details.environment !== this.options.environment) {
          throw new Error("APNs invalidation environment does not match the recipient");
        }
        await clearTransportTokenIfUnchanged(client, this.storedToken(row.ciphertext));
        this.invalidations.push({
          generation: expectedGeneration,
          ...(details.invalidatedAtMs === undefined ? {} : { invalidatedAtMs: details.invalidatedAtMs }),
        });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private resolved(row: TokenRow): ResolvedRecipient {
    if (row.environment !== this.options.environment) {
      throw new Error("APNs recipient environment does not match the selected provider pool");
    }
    const token = this.options.encryption.decrypt(row.ciphertext, this.purpose());
    if (!token) throw new Error("Encrypted APNs recipient token is empty");
    return { token, generation: generation(row.ciphertext) };
  }

  private async select(query: Queryable, lock: boolean): Promise<TokenRow | null> {
    const eventGuard = `e.state='active' AND (e.expires_at IS NULL OR e.expires_at>clock_timestamp())
      AND ${relevanceDeliveryGuard("e")}`;
    const bindingGuard = `j.id=$1 AND j.claim_token=$2 AND j.state='processing'
      AND j.claim_phase='dispatch_started'
      AND j.notification_event_id=$3 AND j.device_id=$4
      AND e.principal_id=$5 AND d.principal_id=e.principal_id
      AND target.notification_event_id=e.id AND target.device_id=d.id`;
    const values = [
      this.options.deliveryJobId,this.options.claimToken,this.options.notificationEventId,
      this.options.deviceId,this.options.principalId,
    ];
    const result = this.options.kind === "notification"
      ? await query.query<TokenRow>(
        `SELECT d.apns_token AS ciphertext,d.apns_environment AS environment
         FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
         JOIN devices d ON d.id=j.device_id
         JOIN notification_event_targets target
           ON target.notification_event_id=e.id AND target.device_id=d.id
         WHERE ${bindingGuard} AND j.transport='notification' AND d.revoked_at IS NULL
           AND d.notification_authorization IN ('authorized','provisional')
           AND d.apns_environment=$6 AND d.apns_token IS NOT NULL AND ${eventGuard}
         ${lock ? "FOR UPDATE OF j,e,d" : ""}`,
        [...values,this.options.environment],
      )
      : this.options.kind === "live_activity_start"
        ? await query.query<TokenRow>(
          `SELECT d.live_activity_push_to_start_token AS ciphertext,d.apns_environment AS environment
           FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
           JOIN devices d ON d.id=j.device_id
           JOIN notification_event_targets target
             ON target.notification_event_id=e.id AND target.device_id=d.id
           WHERE ${bindingGuard} AND j.transport='live_activity_start' AND d.revoked_at IS NULL
             AND d.live_activity_authorization='authorized'
             AND d.apns_environment=$6
             AND d.live_activity_push_to_start_token IS NOT NULL AND ${eventGuard}
           ${lock ? "FOR UPDATE OF j,e,d" : ""}`,
          [...values,this.options.environment],
        )
        : await query.query<TokenRow>(
          `SELECT update_token.token AS ciphertext,update_token.environment
           FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
           JOIN devices d ON d.id=j.device_id
           JOIN live_activities activity ON activity.id=j.live_activity_id
           JOIN live_activity_update_tokens update_token
             ON update_token.device_id=d.id AND update_token.live_activity_id=j.live_activity_id
            AND update_token.generation=activity.generation
           JOIN notification_event_targets target
             ON target.notification_event_id=e.id AND target.device_id=d.id
           WHERE ${bindingGuard} AND j.transport='live_activity_update'
             AND j.live_activity_id=$6 AND activity.generation=$7
             AND e.payload#>>'{liveActivity,generation}'=$7::text
             AND update_token.environment=$8 AND d.revoked_at IS NULL
             AND d.live_activity_authorization='authorized'
             AND ${eventGuard}
           ${lock ? "FOR UPDATE OF j,e,d,activity,update_token" : ""}`,
          [...values,this.options.liveActivityId,this.options.liveActivityGeneration,this.options.environment],
        );
    return result.rows[0] ?? null;
  }

  private purpose(): TransportTokenPurpose {
    return this.options.kind === "notification"
      ? "device.apns_token"
      : this.options.kind === "live_activity_start"
        ? "device.live_activity_push_to_start_token"
        : "live_activity_update_token.token";
  }

  private storedToken(ciphertext: string): StoredTransportToken {
    const purpose = this.purpose();
    return purpose === "live_activity_update_token.token"
      ? {
        purpose,
        deviceId: this.options.deviceId,
        liveActivityId: this.options.liveActivityId!,
        liveActivityGeneration: this.options.liveActivityGeneration!,
        ciphertext,
      }
      : { purpose, deviceId: this.options.deviceId, ciphertext };
  }
}

function generation(ciphertext: string): string {
  return createHash("sha256").update(ciphertext, "utf8").digest("hex");
}
