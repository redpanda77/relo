import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { pendingInteractionBadgeCount } from "../badge.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Canonical ordinary decisions",() => {
  let db: Database,principalId: string,deviceId: string;
  const owner = "decision_owner_abcdefghijklmnopqrstuvwxyz";
  const phone = "decision_phone_abcdefghijklmnopqrstuvwxyz";
  const secret = "decision-relevance-test-secret-at-least-32-characters";
  beforeAll(async () => { db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db); });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    await bootstrapOwner(db,"decisions",owner);
    principalId=(await db.query("SELECT principal_id FROM principal_api_keys WHERE token_hash=$1",[hashToken(owner)])).rows[0].principal_id;
    deviceId=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,apns_token)
      VALUES ($1,$2,$3,'Decision phone','com.example.relo.notifications','1','1','26','sandbox','authorized','fixture-token') RETURNING id`,
      [principalId,randomUUID(),randomUUID()])).rows[0].id;
    await db.query(`INSERT INTO device_credentials(device_id,token_hash,scopes)
      VALUES ($1,$2,ARRAY['interactions:respond','inbox:read'])`,[deviceId,hashToken(phone)]);
  });
  const raw=(id:string)=>id.slice(4);
  const command=(generation=1,revision=1,age=0)=>({subjectKey:"decision:ship",generation,revision,
    operation:revision===1?"replace":"update",occurredAt:new Date(Date.now()-age*1_000).toISOString(),policy:{kind:"decision",actionSeconds:30}});
  async function request(path:string,token:string,body:unknown,key=randomUUID()) {
    const response=await createApp(db,{apnsMode:"disabled",credentialDerivationSecret:secret}).request(path,{
      method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json","idempotency-key":key},body:JSON.stringify(body),
    });
    return {status:response.status,body:await response.json() as any};
  }
  const ask=(relevance:unknown=command(),key=randomUUID())=>request("/api/interactions",owner,{
    type:"yes_no",prompt:"Ship this exact revision?",title:"Decision",expiresInSeconds:30,...(relevance?{relevance}:{}),
  },key);
  const answer=(eventId:string,expectedSubject?:unknown,key=randomUUID())=>request(`/api/notifications/${eventId}/interactions`,phone,{
    kind:"yes",idempotencyKey:key,...(expectedSubject?{expectedSubject}:{}),
  });
  async function row(eventId:string) {
    return (await db.query(`SELECT r.state,r.expires_at,r.responded_at,e.state AS event_state,nr.relevance
      FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id
      JOIN notification_relevance nr ON nr.notification_event_id=e.id WHERE e.id=$1`,[raw(eventId)])).rows[0];
  }
  async function until(predicate:()=>Promise<boolean>) {
    const deadline=performance.now()+5_000;
    while(!await predicate()) {
      if(performance.now()>deadline)throw new Error("database barrier did not arrive");
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  }
  const blocked=(count:number)=>until(async()=>Number((await db.query(`SELECT count(*)::int AS count
    FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`)).rows[0].count)>=count);

  test("original action deadlines survive replay and expired admission is terminal without jobs",async () => {
    const key=randomUUID();const first=await ask(command(1,1,31),key);
    expect(first.status).toBe(201);expect(first.body.interaction.state).toBe("expired");expect(first.body.queued).toBe(0);
    const stored=await row(first.body.eventId);
    expect(stored.state).toBe("expired");expect(stored.event_state).toBe("expired");expect(stored.responded_at).toBeInstanceOf(Date);
    expect(stored.expires_at.toISOString()).toBe(first.body.relevance.deadlines.actionExpiresAt);
    expect(await pendingInteractionBadgeCount(db,deviceId)).toBe(0);
    const replay=await ask({ ...command(),occurredAt:first.body.relevance.deadlines.occurredAt },key);
    expect(replay.status).toBe(200);expect(replay.body.relevance).toEqual(first.body.relevance);
    // A late answer to an expired question is stored as a fact, never permission.
    expect((await answer(first.body.eventId)).status).toBe(200);
    await db.query("DELETE FROM notification_events WHERE id=$1",[raw(first.body.eventId)]);
    const pruned=await ask({ ...command(),occurredAt:first.body.relevance.deadlines.occurredAt },key);
    expect(pruned.status).toBe(409);expect(pruned.body.error).toBe("retired_replay");
  });
  test("an immutable request ID binds a button to its exact decision, including replay", async () => {
    const first = await ask(); const key = randomUUID();
    const path = `/api/notifications/${first.body.eventId}/interactions`;
    const send = (expectedInteractionId: string) => request(path, phone, {
      kind: "yes", idempotencyKey: key, expectedInteractionId,
    });
    const wrong = await send(`int_${randomUUID()}`);
    expect(wrong.status).toBe(409); expect(wrong.body.error).toBe("interaction_version_mismatch");
    expect((await row(first.body.eventId)).state).toBe("pending");
    const accepted = await send(first.body.interaction.id);
    expect(accepted.status).toBe(201);
    expect(accepted.body.decision).toMatchObject({ id: first.body.interaction.id, state: "yes" });
    expect((await send(first.body.interaction.id)).status).toBe(200);
    expect((await send(`int_${randomUUID()}`)).status).toBe(409);
  });
  test("replacement rejects the old exact decision, while unrelated valid decisions remain actionable",async () => {
    const old=await ask();const unrelated=await ask({...command(),subjectKey:"independent"});const current=await ask(command(2));
    expect(current.status).toBe(201);expect((await row(old.body.eventId)).state).toBe("canceled");
    expect((await answer(old.body.eventId,old.body.relevance.identity)).body.error).toBe("interaction_superseded");
    expect((await row(unrelated.body.eventId)).state).toBe("pending");
    const wrong=await answer(current.body.eventId,{...current.body.relevance.identity,revision:2});
    expect(wrong.status).toBe(409);expect(wrong.body.error).toBe("interaction_version_mismatch");
    expect((await row(current.body.eventId)).state).toBe("pending");
    const key=randomUUID();const accepted=await answer(current.body.eventId,current.body.relevance.identity,key);
    expect(accepted.status).toBe(201);expect(accepted.body.decision).toMatchObject({id:current.body.interaction.id,state:"yes"});
    expect(accepted.body.decision.respondedAt).toBeTruthy();
    expect((await row(current.body.eventId)).relevance.status).toBe("settled");
    expect((await ask(command(2,2))).body.error).toBe("requires_replace");
    expect((await ask(command(3))).status).toBe(201);
    const replay=await answer(current.body.eventId,current.body.relevance.identity,key);
    expect(replay.status).toBe(200);expect(replay.body.replayed).toBe(true);expect(replay.body.decision.state).toBe("yes");
  });
  test("default requests get independent persistent identity and duplicate explicit versions reuse a receipt",async () => {
    const key=randomUUID();const first=await ask(null,key);const replay=await ask(null,key);
    expect(first.status).toBe(201);expect(replay.status).toBe(200);expect(replay.body.eventId).toBe(first.body.eventId);
    const explicit=command();explicit.subjectKey="other";
    const original=await ask(explicit);const duplicate=await ask(explicit);
    expect(duplicate.status).toBe(200);expect(duplicate.body.interaction.id).toBe(original.body.interaction.id);
    expect(duplicate.body.relevance).toEqual(original.body.relevance);
    const invalid=await ask({...command(),subjectKey:"conflict",policy:{kind:"decision",actionSeconds:60}});
    expect(invalid.status).toBe(400);
  });
  test.each(["response","replacement"] as const)("%s first wins its request lock without a head-lock cycle",async first => {
    const old=await ask();expect(old.status).toBe(201);
    const blocker=await db.connect();await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM interaction_requests WHERE id=$1 FOR UPDATE",[raw(old.body.interaction.id)]);
    let response!:ReturnType<typeof answer>,replacement!:ReturnType<typeof ask>;
    try {
      if(first==="response") {
        response=answer(old.body.eventId,old.body.relevance.identity);await blocked(1);
        replacement=ask(command(2));await blocked(2);
      } else {
        replacement=ask(command(2));await blocked(1);
        response=answer(old.body.eventId,old.body.relevance.identity);await blocked(2);
      }
    } finally {await blocker.query("ROLLBACK");blocker.release();}
    const [responded,replaced]=await Promise.all([response,replacement]);
    expect(replaced.status).toBe(201);expect(responded.status).toBe(first==="response"?201:409);
    expect((await row(old.body.eventId)).state).toBe(first==="response"?"yes":"canceled");
    expect((await row(replaced.body.eventId)).state).toBe("pending");
    expect((await db.query("SELECT count(*)::int AS count FROM interactions WHERE notification_event_id=$1",[raw(old.body.eventId)])).rows[0].count).toBe(first==="response"?1:0);
  });
  test("a response held across the actual deadline cannot rely on transaction-start time",async () => {
    const decision=await ask();expect(decision.status).toBe(201);
    await db.query("UPDATE interaction_requests SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",[raw(decision.body.interaction.id)]);
    const blocker=await db.connect();await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM interaction_requests WHERE id=$1 FOR UPDATE",[raw(decision.body.interaction.id)]);
    const responding=answer(decision.body.eventId,decision.body.relevance.identity);
    try {
      await blocked(1);
      await until(async()=>Boolean((await db.query("SELECT expires_at<=clock_timestamp() AS expired FROM interaction_requests WHERE id=$1",[raw(decision.body.interaction.id)])).rows[0].expired));
    } finally {await blocker.query("ROLLBACK");blocker.release();}
    expect((await responding).status).toBe(409);expect((await row(decision.body.eventId)).state).toBe("expired");
    expect((await db.query("SELECT count(*)::int AS count FROM interactions")).rows[0].count).toBe(0);
  });
});
