import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("Canonical ActivityKit decisions",()=>{
  let db:Database,principalId:string,deviceId:string;
  const owner="activity_admission_owner_abcdefghijklmnopqrstuvwxyz",phone="activity_admission_phone_abcdefghijklmnopqrstuvwxyz";
  beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
  afterAll(async()=>{await db.end();});
  beforeEach(async()=>{
    await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"owner",owner);
    principalId=(await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    deviceId=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,live_activity_push_to_start_token)
      VALUES ($1,$2,$3,'Decision phone','com.example.relo.notifications','1','1','26','sandbox','authorized','authorized','fixture-token') RETURNING id`,
      [principalId,randomUUID(),randomUUID()])).rows[0].id;
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['interactions:respond'])",[deviceId,hashToken(phone)]);
  });
  const command=(generation=1,revision=1,age=0)=>({subjectKey:"ship",generation,revision,operation:revision===1?"replace":"update",
    occurredAt:new Date(Date.now()-age*1000).toISOString(),policy:{kind:"decision",actionSeconds:30}});
  async function request(path:string,token:string,body:unknown,key=randomUUID()){
    const response=await createApp(db,{apnsMode:"sandbox",credentialDerivationSecret:"activity-admission-secret-at-least-32-characters"}).request(path,{
      method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json","idempotency-key":key},body:JSON.stringify(body),
    });return {status:response.status,body:await response.json() as any};
  }
  const ask=(relevance:unknown=command(),key=randomUUID(),presentation="live_activity")=>request("/api/interactions",owner,{
    title:"Review",prompt:"Ship?",type:"yes_no",expiresInSeconds:30,presentation,...(relevance?{relevance}:{}),
  },key);
  const answer=(item:any)=>request(`/api/notifications/${item.eventId}/interactions`,phone,{kind:"yes",idempotencyKey:randomUUID(),expectedSubject:item.relevance.identity});
  const activity=async(id:string)=>(await db.query("SELECT * FROM live_activities WHERE id=$1",[id.slice(4)])).rows[0];
  test("default decisions persist independent canonical deadlines matching their native activity",async()=>{
    const first=await ask(null),second=await ask(null);expect(first.status).toBe(201);expect(second.status).toBe(201);
    expect(first.body.relevance?.deadlines.kind).toBe("decision");
    expect(first.body.relevance.identity.subjectKey).not.toBe(second.body.relevance.identity.subjectKey);
    expect((await activity(first.body.liveActivityId)).expires_at.toISOString()).toBe(first.body.relevance.deadlines.actionExpiresAt);
    expect(first.body.queued).toBe(1);
  });
  test("expired arrival is terminal, queues no commands, and cannot revive after history pruning",async()=>{
    const relevance=command(1,1,31),key=randomUUID(),first=await ask(relevance,key);
    expect(first.status).toBe(201);expect(first.body.interaction.state).toBe("expired");expect(first.body.queued).toBe(0);
    expect(first.body.delivery.durableCommands).toBe(0);
    const stored=await activity(first.body.liveActivityId);expect(stored.state).toBe("expired");
    expect(stored.presentation.behavior.type).toBe("informational");expect(stored.expires_at.toISOString()).toBe(first.body.relevance.deadlines.actionExpiresAt);
    expect((await answer(first.body)).status).toBe(200); // late answer: a stored fact, not permission
    const replay=await ask(relevance);expect(replay.status).toBe(200);expect(replay.body.relevance).toEqual(first.body.relevance);
    expect(replay.body.liveActivityId).toBe(first.body.liveActivityId);
    await db.query("DELETE FROM notification_events WHERE id=$1",[first.body.eventId.slice(4)]);
    const pruned=await ask(relevance,key);expect(pruned.status).toBe(409);expect(pruned.body.error).toBe("retired_replay");
    expect((await db.query("SELECT count(*)::int AS n FROM live_activities")).rows[0].n).toBe(1);
  });
  test.each(["live_activity","notification"])("replacement by %s retires the old prompt and keeps native cleanup deliverable",async presentation=>{
    const first=await ask(),independent=await ask({...command(),subjectKey:"independent"});expect(first.status).toBe(201);
    const replacement=await ask(command(2),randomUUID(),presentation);expect(replacement.status).toBe(201);
    expect((await activity(first.body.liveActivityId)).state).toBe("ended");expect((await activity(independent.body.liveActivityId)).state).toBe("active");
    expect((await answer(first.body)).body.error).toBe("interaction_superseded");
    expect((await db.query("SELECT state FROM delivery_jobs WHERE notification_event_id=$1",[first.body.eventId.slice(4)])).rows[0].state).toBe("canceled");
    const cleanup=(await db.query(`SELECT e.id,e.expires_at,nr.subject_id,j.state FROM notification_events e
      LEFT JOIN notification_relevance nr ON nr.notification_event_id=e.id JOIN delivery_jobs j ON j.notification_event_id=e.id
      WHERE e.payload#>>'{liveActivity,activityId}'=$1 AND e.payload#>>'{liveActivity,operation}'='end'`,[first.body.liveActivityId])).rows;
    expect(cleanup).toHaveLength(1);expect(cleanup[0].subject_id).toBeNull();expect(cleanup[0].state).toBe("pending");
    expect(cleanup[0].expires_at.getTime()-Date.now()).toBeGreaterThan(3_500_000);
    expect((await answer(replacement.body)).status).toBe(201);
  });
  test("same and new idempotency keys replay one original activity without moving its deadline",async()=>{
    const relevance=command(),key=randomUUID(),first=await ask(relevance,key);expect(first.status).toBe(201);
    for(const replayKey of [key,randomUUID()]){
      const replay=await ask(relevance,replayKey);expect(replay.status).toBe(200);expect(replay.body.replayed).toBe(true);
      expect(replay.body.liveActivityId).toBe(first.body.liveActivityId);expect(replay.body.relevance).toEqual(first.body.relevance);
    }
    expect((await db.query("SELECT count(*)::int AS n FROM live_activities")).rows[0].n).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM interaction_requests")).rows[0].n).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM delivery_jobs")).rows[0].n).toBe(1);
  });
  test.each(["answer","replacement"])("%s first wins its exact decision while replacement still advances safely",async first=>{
    const original=await ask();expect(original.status).toBe(201);
    const holder=await db.connect();await holder.query("BEGIN");
    await holder.query("SELECT id FROM interaction_requests WHERE id=$1 FOR UPDATE",[original.body.interaction.id.slice(4)]);
    const waitForLocks=async(count:number)=>{
      const deadline=performance.now()+3000;
      while((await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n<count){
        if(performance.now()>deadline)throw new Error("lock barrier timed out");await new Promise(resolve=>setTimeout(resolve,10));
      }
    };
    let answering!:ReturnType<typeof answer>,replacing!:ReturnType<typeof ask>;
    try{
      if(first==="answer"){answering=answer(original.body);await waitForLocks(1);replacing=ask(command(2));}
      else{replacing=ask(command(2));await waitForLocks(1);answering=answer(original.body);}
      await waitForLocks(2);
    }finally{await holder.query("ROLLBACK");holder.release();}
    const [answered,replaced]=await Promise.all([answering,replacing]);
    expect(answered.status).toBe(first==="answer"?201:409);expect(replaced.status).toBe(201);
    expect((await activity(original.body.liveActivityId)).state).toBe("ended");
    expect((await activity(replaced.body.liveActivityId)).state).toBe("active");
    expect((await db.query("SELECT count(*)::int AS n FROM interactions")).rows[0].n).toBe(first==="answer"?1:0);
  });

});
