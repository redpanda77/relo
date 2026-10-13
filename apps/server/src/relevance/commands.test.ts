import { createHash,randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { relevanceItemSchema } from "@relo/notification-contracts";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { applySubjectMutation,independentSubjectKey,lockSubjectForEvent,type SubjectCommand } from "./commands.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("Canonical subject transaction foundation",()=>{
  let db:Database,principalId:string,deviceId:string;
  const sourceId="key_test-source";
  beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
  afterAll(async()=>{await db.end();});
  beforeEach(async()=>{
    await db.query("TRUNCATE owner_principals CASCADE");
    principalId=(await db.query("INSERT INTO owner_principals(handle) VALUES ($1) RETURNING id",[randomUUID()])).rows[0].id;
    deviceId=(await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment) VALUES ($1,$2,$3,'Subject','com.example.relo.notifications','1','1','26','sandbox') RETURNING id`,
      [principalId,randomUUID(),randomUUID()])).rows[0].id;
  });
  const command=(revision=1,generation=1):SubjectCommand=>({subjectKey:"decision:release",generation,revision,
    operation:revision===1?"replace":"update",occurredAt:"2026-01-01T00:00:00.000Z",policy:{kind:"decision",actionSeconds:900}});
  const hash=(input:SubjectCommand)=>createHash("sha256").update(JSON.stringify(input)).digest("hex");
  async function event(tx:Pick<PoolClient,"query">,owner=principalId){
    return (await tx.query(`INSERT INTO notification_events(principal_id,source,kind,title,body,idempotency_key)
      VALUES ($1,'Subject','approval','Subject','Subject',$2) RETURNING id`,[owner,randomUUID()])).rows[0].id as string;
  }
  async function admit(input=command(),actorSource=sourceId,withDecision=false){
    const tx=await db.connect();try{
      await tx.query("BEGIN");const eventId=await event(tx);
      const result=await applySubjectMutation(tx,{principalId,sourceId:actorSource},{eventId,command:input,intentHash:hash(input)});
      if(result.kind==="duplicate")await tx.query("ROLLBACK");
      else{
        if(withDecision){
          await tx.query(`INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at)
            VALUES ($1,$2,'approval','Continue?',$3,now()+interval '1 hour')`,[principalId,eventId,hash(input)]);
          await tx.query("INSERT INTO delivery_jobs(notification_event_id,device_id,state) VALUES ($1,$2,'retry')",[eventId,deviceId]);
        }
        await tx.query("COMMIT");
      }
      return {eventId,result};
    }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
  }
  test("replacement retires old requests and unsent jobs atomically and retains explicit supersession",async()=>{
    const first=await admit(command(),sourceId,true);
    const next=await admit(command(1,2));
    expect(next.result.kind).toBe("applied");
    expect((await db.query("SELECT state FROM interaction_requests WHERE notification_event_id=$1",[first.eventId])).rows[0].state).toBe("canceled");
    expect((await db.query("SELECT state,last_error_code FROM delivery_jobs WHERE notification_event_id=$1",[first.eventId])).rows[0]).toMatchObject({state:"canceled",last_error_code:"subject_superseded"});
    const stored=(await db.query("SELECT relevance FROM notification_relevance WHERE notification_event_id=$1",[first.eventId])).rows[0].relevance;
    expect(relevanceItemSchema.parse(stored).supersededBy?.generation).toBe(2);
  });
  test("duplicate does not extend deadlines; differing intent at the same version is rejected",async()=>{
    const first=await admit();const duplicate=await admit();
    expect(duplicate.result).toMatchObject({kind:"duplicate",eventId:first.eventId,relevance:first.result.relevance});
    await expect(admit({...command(),policy:{kind:"decision",actionSeconds:1800}})).rejects.toMatchObject({code:"version_conflict"});
  });
  test("history deletion preserves the generation fence and a pruned duplicate cannot become new current work",async()=>{
    const first=await admit();
    await db.query("DELETE FROM notification_events WHERE id=$1",[first.eventId]);
    await expect(admit()).rejects.toMatchObject({code:"retired_replay"});
    await admit(command(1,2));
    await expect(admit(command(5,1))).rejects.toMatchObject({code:"stale"});
    expect((await db.query("SELECT count(*)::int AS count FROM relevance_subjects")).rows[0].count).toBe(1);
  });
  test("out-of-order revisions race under one lock and cannot roll the pointer backwards",async()=>{
    await admit();
    const results=await Promise.allSettled([admit(command(3)),admit(command(2))]);
    expect(results[0].status).toBe("fulfilled");
    const stored=(await db.query("SELECT revision FROM relevance_subjects")).rows[0];
    expect(Number(stored.revision)).toBe(3);
    if(results[1].status==="rejected")expect(results[1].reason.code).toBe("stale");
  });
  test("source and decision scopes remain independent; cross-account event attachment is rejected",async()=>{
    await admit();await admit(command(),"key_other-source");await admit({...command(),subjectKey:"independent-decision"});
    expect((await db.query("SELECT count(*)::int AS count FROM relevance_subjects")).rows[0].count).toBe(3);
    const other=(await db.query("INSERT INTO owner_principals(handle) VALUES ($1) RETURNING id",[randomUUID()])).rows[0].id;
    const tx=await db.connect();try{
      await tx.query("BEGIN");const eventId=await event(tx,other);
      const input={...command(),subjectKey:"foreign"};
      await expect(applySubjectMutation(tx,{principalId,sourceId},{eventId,command:input,intentHash:hash(input)})).rejects.toMatchObject({code:"not_found"});
    }finally{await tx.query("ROLLBACK");tx.release();}
  });
  test("a later outbox failure rolls head, supersession and request cancellation back together",async()=>{
    const first=await admit(command(),sourceId,true);
    const tx=await db.connect();try{
      await tx.query("BEGIN");const eventId=await event(tx);const input=command(1,2);
      await applySubjectMutation(tx,{principalId,sourceId},{eventId,command:input,intentHash:hash(input)});
      await expect(tx.query("INSERT INTO delivery_jobs(notification_event_id,device_id) VALUES ($1,$2)",[eventId,randomUUID()])).rejects.toThrow();
      await tx.query("ROLLBACK");
    }finally{await tx.query("ROLLBACK");tx.release();}
    expect((await db.query("SELECT generation FROM relevance_subjects")).rows[0].generation).toBe("1");
    expect((await db.query("SELECT state FROM interaction_requests WHERE notification_event_id=$1",[first.eventId])).rows[0].state).toBe("pending");
    expect((await db.query("SELECT superseded_at FROM notification_relevance WHERE notification_event_id=$1",[first.eventId])).rows[0].superseded_at).toBeNull();
  });
  test("response lock observes the current subject; independent keys are stable and bounded",async()=>{
    const old=await admit();await admit(command(1,2));
    const tx=await db.connect();try{
      await tx.query("BEGIN");const result=await lockSubjectForEvent(tx,principalId,old.eventId);
      expect(result?.relevance.identity.generation).toBe(1);expect(result?.current.generation).toBe(2);
      expect(result?.current.accountId).toBe(`acc_${principalId}`);
    }finally{await tx.query("ROLLBACK");tx.release();}
    expect(independentSubjectKey("stable")).toBe(independentSubjectKey("stable"));
    expect(independentSubjectKey("stable")).not.toBe(independentSubjectKey("other"));
    expect(independentSubjectKey("a".repeat(200)).length).toBeLessThan(200);
  });
});
