import { createHash } from "node:crypto";
import type { ActivitySend,ApnsEnvironment,ApnsOutcome,OutcomeCategory,RecipientResolver,ResolvedRecipient } from "./apns-provider-cleanroom.js";
import { inviteStatus } from "./computer-invites.js";
import type { Database } from "./db.js";
import { internalId,publicId } from "./ids.js";
import { PostgresListener } from "./postgres-listener.js";
import type { TransportTokenEncryption } from "./token-encryption.js";

/**
 * The wizard's Live Activity on the phone that made a code (plan 13, journey E). The phone starts the activity itself
 * and registers its push token on the invite; every move of the invite is then one ActivityKit push with enums plus
 * the computer's login name (docs/ENCRYPTION-PROTOCOL.md, "server sends enums"). The API only flags the invite
 * (`queueInviteActivityPush`, from wakeAccountStreams); the worker, which owns the APNs client, derives the state with
 * inviteStatus, pushes it when it differs from the last one pushed, and ends the activity at `reported` or later.
 * Expiry is not an event: the app ends a stale activity itself. A push that fails never touches the request.
 */
export const INVITE_ACTIVITY_CHANNEL = "relo_invite_activity_pushes";
export const INVITE_ACTIVITY_DISMISS_SECONDS = 15 * 60;
/** An invite older than this stops being pushed to (a code lives 30 minutes). */
const GIVE_UP_AFTER_HOURS = 3;
const END_STATES = new Set(["reported","tested","expired"]);

export type InviteActivitySender = { sendInviteActivity(input: ActivitySend): Promise<ApnsOutcome> };

/** The invite's activity token, sealed; null when the invite is unknown, another account's, or the caller is not a device. */
export async function registerInviteActivityToken(db: Pick<Database,"query">,encryption: Pick<TransportTokenEncryption,"encrypt">,
  input: { principalId: string; deviceId: string; inviteId: string; pushToken: string }): Promise<boolean> {
  const id = internalId("cin",input.inviteId);
  if (!id) return false;
  const sealed = encryption.encrypt(input.pushToken.toLowerCase(),"computer_invite_activity.token");
  // last_state "waiting" is what the phone's activity shows when it starts; a code that already moved is pushed at once.
  const result = await db.query(
    `UPDATE computer_invites SET activity_push_token=$3,activity_device_id=$4,activity_last_state='waiting',activity_push_pending=true
     WHERE id=$1 AND principal_id=$2`,[id,input.principalId,sealed,input.deviceId]);
  if (!result.rowCount) return false;
  await db.query("SELECT pg_notify($1,'')",[INVITE_ACTIVITY_CHANNEL]).catch(() => undefined);
  return true;
}

/** Flags the account's invites that have an activity: they may have moved. Never fails the caller. */
export async function queueInviteActivityPush(db: Pick<Database,"query">,principalId: string): Promise<void> {
  try {
    const flagged = await db.query(
      "UPDATE computer_invites SET activity_push_pending=true WHERE principal_id=$1 AND activity_push_token IS NOT NULL",[principalId]);
    if (flagged.rowCount) await db.query("SELECT pg_notify($1,'')",[INVITE_ACTIVITY_CHANNEL]);
  } catch (error) {
    console.warn(JSON.stringify({ event: "invite_activity_queue_failed",message: error instanceof Error ? error.message : String(error) }));
  }
}

/** The content state the app decodes (Date as epoch seconds, like every ContentState). */
export function inviteActivityContentState(status: { state: string; computer: { name: string; harnesses: { id: string; level: string }[] } | null },
  nowSeconds: number) {
  return { state: status.state,computerName: status.computer?.name ?? null,
    agents: (status.computer?.harnesses ?? []).filter((harness) => harness.level !== "none").map((harness) => harness.id),
    updatedAt: nowSeconds };
}

const RETRYABLE = new Set<OutcomeCategory>(["indeterminate-transport","retry-exhausted","retryable-not-scheduled","retry-scheduled",
  "pool-quarantined","expired-provider-token","bounded-protocol-failure","ambiguous-rate-limit","recipient-throttled","provider-token-cadence"]);

export type InviteActivityCycle = { claimed: number; pushed: number; ended: number; unchanged: number; retried: number; dropped: number };

/** One pass: every flagged invite is claimed, its state derived, and pushed if it moved. */
export async function dispatchInviteActivityPushes(db: Database,input: {
  sender: InviteActivitySender; encryption: TransportTokenEncryption; environment: ApnsEnvironment; now?: () => Date; limit?: number;
}): Promise<InviteActivityCycle> {
  const cycle: InviteActivityCycle = { claimed: 0,pushed: 0,ended: 0,unchanged: 0,retried: 0,dropped: 0 };
  const now = input.now ?? (() => new Date());
  const claimed = (await db.query<{ id: string; principal_id: string; activity_push_token: string; activity_last_state: string | null }>(
    `UPDATE computer_invites SET activity_push_pending=false WHERE id IN (
       SELECT id FROM computer_invites WHERE activity_push_pending AND activity_push_token IS NOT NULL
       ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING id,principal_id,activity_push_token,activity_last_state`,[input.limit ?? 50])).rows;
  cycle.claimed = claimed.length;
  for (const row of claimed) {
    try {
      const status = await inviteStatus(db,row.principal_id,publicId("cin",row.id));
      if (!status) { cycle.dropped += 1;continue; }
      if (status.state === row.activity_last_state) { cycle.unchanged += 1;continue; }
      const end = END_STATES.has(status.state);
      const seconds = Math.floor(now().getTime() / 1_000);
      const outcome = await input.sender.sendInviteActivity({
        recipient: new InviteActivityRecipient(db,input.encryption,row.id,row.activity_push_token),
        operation: end ? "end" : "update",
        contentState: inviteActivityContentState(status,seconds),
        ...(end ? { dismissalDate: seconds + INVITE_ACTIVITY_DISMISS_SECONDS } : {}),
        expiration: seconds + 15 * 60,
      }).catch((): undefined => undefined);
      const category = outcome?.category ?? "indeterminate-transport";
      if (category === "accepted") {
        if (end) {
          await db.query(
            "UPDATE computer_invites SET activity_last_state=$2,activity_push_token=NULL,activity_device_id=NULL,activity_push_pending=false WHERE id=$1",
            [row.id,status.state]);
          cycle.ended += 1;
        } else {
          await db.query("UPDATE computer_invites SET activity_last_state=$2 WHERE id=$1",[row.id,status.state]);
          cycle.pushed += 1;
        }
      } else if (RETRYABLE.has(category)) {
        await db.query(
          `UPDATE computer_invites SET activity_push_pending=true WHERE id=$1 AND activity_push_token IS NOT NULL
             AND created_at>now()-make_interval(hours => $2)`,[row.id,GIVE_UP_AFTER_HOURS]);
        cycle.retried += 1;
      } else {
        // The token is no good (stale, unregistered, refused): the phone's activity is gone.
        await db.query("UPDATE computer_invites SET activity_push_token=NULL,activity_device_id=NULL WHERE id=$1",[row.id]);
        cycle.dropped += 1;
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "invite_activity_push_failed",message: error instanceof Error ? error.message : String(error) }));
    }
  }
  return cycle;
}

/** The activity's own push token as APNs wants it; the sealed value stays in the database, a stale one is cleared. */
class InviteActivityRecipient implements RecipientResolver {
  constructor(private readonly db: Database,private readonly encryption: TransportTokenEncryption,private readonly inviteId: string,
    private readonly sealed: string) {}
  async resolve(): Promise<ResolvedRecipient | null> {
    const token = this.encryption.decrypt(this.sealed,"computer_invite_activity.token");
    return token ? { token,generation: createHash("sha256").update(this.sealed,"utf8").digest("hex") } : null;
  }
  async invalidate(expectedGeneration: string): Promise<void> {
    if (createHash("sha256").update(this.sealed,"utf8").digest("hex") !== expectedGeneration) return;
    await this.db.query("UPDATE computer_invites SET activity_push_token=NULL,activity_device_id=NULL WHERE id=$1 AND activity_push_token=$2",
      [this.inviteId,this.sealed]);
  }
}

/** The worker's loop: woken by the API's flag, with a poll as the fallback. */
export async function runInviteActivityLoop(db: Database,input: {
  sender: InviteActivitySender; encryption: TransportTokenEncryption; environment: ApnsEnvironment; pollMs: number; signal: AbortSignal;
}): Promise<void> {
  let wake: (() => void) | undefined;
  let pending = false;
  const listener = await PostgresListener.listen(db,INVITE_ACTIVITY_CHANNEL,() => { pending = true;wake?.(); });
  try {
    while (!input.signal.aborted) {
      pending = false;
      try { await dispatchInviteActivityPushes(db,input); } catch (error) {
        console.warn(JSON.stringify({ event: "invite_activity_cycle_failed",message: error instanceof Error ? error.message : String(error) }));
      }
      if (pending) continue;
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer);input.signal.removeEventListener("abort",done);wake = undefined;resolve(); };
        const timer = setTimeout(done,input.pollMs);
        input.signal.addEventListener("abort",done,{ once: true });
        wake = done;
      });
    }
  } finally {
    await listener.close();
  }
}
