import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,describe,expect,test } from "vitest";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { InteractionChangeHub } from "./interaction-change-hub.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("PostgreSQL committed interaction wakeup",() => {
  let db: Database,principalId: string,interactionId: string;
  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);
    principalId = (await db.query("INSERT INTO owner_principals(handle) VALUES ($1) RETURNING id",[`wake-${randomUUID()}`])).rows[0].id;
    const eventId = (await db.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key)
      VALUES ($1,'Wake','Wake','Wake',$2) RETURNING id`,[principalId,randomUUID()])).rows[0].id;
    interactionId = (await db.query(`INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at)
      VALUES ($1,$2,'approval','Continue?',$3,now()+interval '1 hour') RETURNING id`,[principalId,eventId,"a".repeat(64)])).rows[0].id;
  });
  afterAll(async () => { if (principalId) await db.query("DELETE FROM owner_principals WHERE id=$1",[principalId]);await db.end(); });

  test("notification cannot escape an uncommitted or rolled-back decision",async () => {
    const hub = await InteractionChangeHub.listen(db);
    const subscription = hub.subscribe(principalId,interactionId,"test-client")!;
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");await tx.query("UPDATE interaction_requests SET state='approved' WHERE id=$1",[interactionId]);
      await expect(subscription.wait(10)).resolves.toBe("timeout");
      await tx.query("ROLLBACK");await expect(subscription.wait(10)).resolves.toBe("timeout");
      await tx.query("BEGIN");await tx.query("UPDATE interaction_requests SET state='approved' WHERE id=$1",[interactionId]);
      const waiting = subscription.wait(1_000);await tx.query("COMMIT");
      await expect(waiting).resolves.toBe("changed");
    } finally { await tx.query("ROLLBACK");tx.release();subscription.close();await hub.close(); }
  });

  test("a lost listener reconnects and catches a decision committed during the gap",async () => {
    const hub = await InteractionChangeHub.listen(db);
    const subscription = hub.subscribe(principalId,interactionId,"test-client")!;
    try {
      const pid = (await db.query(`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND query='LISTEN relo_interaction_changes' AND state='idle'`)).rows[0]?.pid;
      expect(pid).toBeDefined();
      const lost = subscription.wait(1_000);
      await db.query("SELECT pg_terminate_backend($1)",[pid]);
      await expect(lost).resolves.toBe("changed");
      await db.query("UPDATE interaction_requests SET state='denied' WHERE id=$1",[interactionId]);
      await expect(subscription.wait(2_000)).resolves.toBe("changed");
      expect((await db.query("SELECT state FROM interaction_requests WHERE id=$1",[interactionId])).rows[0].state).toBe("denied");
      const live = subscription.wait(1_000);
      await db.query("UPDATE interaction_requests SET state='canceled' WHERE id=$1",[interactionId]);
      await expect(live).resolves.toBe("changed");
    } finally { subscription.close();await hub.close(); }
  });
});
