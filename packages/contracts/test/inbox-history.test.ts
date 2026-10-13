import assert from "node:assert/strict";
import test from "node:test";
import { inboxHistorySummarySchema,inboxSnapshotResponseSchema } from "../src/index.js";

const now="2026-10-01T00:00:00.000000Z";
const summary={id:"ntf_11111111-1111-1111-1111-111111111111",kind:"notification",sourceName:"Fixture",sourceImageUrl:null,
  title:"History",contentSummary:{summary:"Preview",format:"text",byteLength:65536},readAt:null,withdrawnAt:null,result:null,
  deliveryState:null,apnsAcceptedAt:null,receivedAt:null,openedAt:null,createdAt:now,updatedAt:now,destinationUrl:null,
  privacy:"standard",interaction:null,context:null,resources:null,activityEvent:null,relevance:null};
const snapshot={items:[summary],total:10000,unread:{account:9000,projects:{direct:9000}},serverTime:now,readWatermark:null};
test("history totals are independent of the retained summary window",()=>{
  assert.deepEqual(inboxSnapshotResponseSchema.parse(snapshot),snapshot);
});
for (const field of ["body","detail","content","payload","liveActivity"]) {
  test(`history rejects full detail or command field ${field}`,()=>{
    assert.equal(inboxHistorySummarySchema.safeParse({...summary,[field]:"must remain on demand"}).success,false);
  });
}
test("history bounds rows and rejects repeated identities or inconsistent totals",()=>{
  assert.equal(inboxSnapshotResponseSchema.safeParse({...snapshot,items:[summary,summary]}).success,false);
  assert.equal(inboxSnapshotResponseSchema.safeParse({...snapshot,total:0}).success,false);
  assert.equal(inboxSnapshotResponseSchema.safeParse({...snapshot,items:Array.from({length:251},(_,i)=>({...summary,id:`ntf_item${i}`}))}).success,false);
});
test("history keeps bounded Unicode summaries and historical private metadata decodable",()=>{
  assert.equal(inboxHistorySummarySchema.safeParse({...summary,title:"🙂".repeat(200),sourceName:"🙂".repeat(200),
    privacy:"private",contentSummary:{...summary.contentSummary,summary:"🙂".repeat(240)}}).success,true);
});
