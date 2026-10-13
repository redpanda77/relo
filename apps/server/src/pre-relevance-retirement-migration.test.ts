import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseSuite = databaseUrl ? describe : describe.skip;

databaseSuite("0058 retires notifications written before relevance admission", () => {
  let db: Database;
  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
  });
  afterAll(async () => db.end());

  test("expires metadata-free ordinary events and their pending requests, never Live Activity events", async () => {
    const unique = randomUUID();
    const principal = (await db.query<{ id: string }>(
      "INSERT INTO owner_principals(handle) VALUES ($1) RETURNING id",[`pre-relevance-${unique}`],
    )).rows[0]!.id;
    const insertEvent = async (kind: string, key: string) => (await db.query<{ id: string }>(
      `INSERT INTO notification_events(principal_id,source,kind,title,body,idempotency_key)
       VALUES ($1,'Old producer',$2,'Old','Body',$3) RETURNING id`,[principal,kind,`${key}-${unique}`],
    )).rows[0]!.id;
    const notice = await insertEvent("notification","notice");
    const decision = await insertEvent("approval","decision");
    const native = await insertEvent("live_activity","native");
    await db.query(
      `INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at)
       VALUES ($1,$2,'approval','Ship?',$3,now()+interval '1 hour')`,[principal,decision,`hash-${unique}`],
    );

    await db.query(await readFile(
      new URL("../migrations/0058_retire_pre_relevance_notifications.sql",import.meta.url),"utf8",
    ));

    const events = (await db.query<{ id: string; state: string }>(
      "SELECT id,state::text FROM notification_events WHERE principal_id=$1",[principal],
    )).rows;
    const state = (id: string) => events.find((row) => row.id === id)?.state;
    expect(state(notice)).toBe("expired");
    expect(state(decision)).toBe("expired");
    expect(state(native)).toBe("active");
    const request = (await db.query<{ state: string; responded_at: Date | null }>(
      "SELECT state::text,responded_at FROM interaction_requests WHERE notification_event_id=$1",[decision],
    )).rows[0]!;
    expect(request.state).toBe("expired");
    expect(request.responded_at).toBeInstanceOf(Date);
  });
});
