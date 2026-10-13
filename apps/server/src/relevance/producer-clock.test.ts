import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";

const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
suite("Producer clock lead at HTTP admission",()=>{
  let db:Database;
  const owner="producer_clock_owner_abcdefghijklmnopqrstuvwxyz";
  beforeAll(async()=>{db=createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db);});
  afterAll(async()=>{await db.end();});
  beforeEach(async()=>{await db.query("TRUNCATE owner_principals CASCADE");await bootstrapOwner(db,"owner",owner);});
  test.each(["notice","decision"] as const)("%s admits a small clock lead immediately without extending replay deadlines",async kind=>{
    const application=createApp(db,{apnsMode:"disabled",credentialDerivationSecret:"producer-clock-secret-at-least-32-characters"});
    const original=(await db.query<{ at:Date }>("SELECT clock_timestamp()+interval '800 milliseconds' AS at")).rows[0]!.at.toISOString();
    const relevance={subjectKey:randomUUID(),generation:1,revision:1,operation:"replace",occurredAt:original,
      policy:kind==="notice"?{kind}:{kind,actionSeconds:30}};
    const body=kind==="notice"?{sourceName:"Clock",title:"Clock",body:"Immediate",relevance}:{type:"yes_no",title:"Clock",prompt:"Immediate?",expiresInSeconds:30,relevance};
    const request=async()=>{
      const response=await application.request(kind==="notice"?"/api/notifications":"/api/interactions",{
        method:"POST",headers:{authorization:`Bearer ${owner}`,"content-type":"application/json","idempotency-key":randomUUID()},body:JSON.stringify(body),
      });return {status:response.status,body:await response.json() as any};
    };
    const first=await request();expect(first.status).toBe(201);
    const deadlines=first.body.relevance.deadlines;
    expect(deadlines.occurredAt).toBe(original);
    expect(Date.parse(original)).toBeGreaterThan(Date.parse(deadlines.acceptedAt));
    expect(Date.parse(deadlines.deliverUntil)-Date.parse(deadlines.acceptedAt)).toBe(kind==="notice"?60_000:30_000);
    if(kind==="decision")expect(first.body.interaction.state).toBe("pending");
    const replay=await request();expect(replay.status).toBe(200);
    expect(replay.body.relevance).toEqual(first.body.relevance);expect(replay.body.eventId).toBe(first.body.eventId);
    expect((await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n).toBe(1);
  });
});
