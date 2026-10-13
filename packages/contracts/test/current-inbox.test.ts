import assert from "node:assert/strict";
import test from "node:test";
import { currentInboxResponseSchema,currentSubjectProjectionSchema,currentSubjectIdSchema,currentChangeHintSchema } from "../src/current-inbox.js";
const id="ntf_10000000-0000-4000-8000-000000000001";
const timestamp="2026-09-30T12:00:00.000Z";
const item={subjectId:id,notificationId:id,kind:"notice",version:{generation:1,revision:1},
 title:"Current notice",summary:"Summary",source:"Fixture",createdAt:timestamp,updatedAt:timestamp,occurredAt:null,
 acceptedAt:timestamp,readAt:null,currentUntil:"2026-09-30T12:15:00.000Z",freshUntil:null,deliverUntil:"2026-09-30T12:01:00.000Z",
 freshness:"unknown",interaction:null,activity:null,resources:null};
const response={items:[item],retired:[],total:100,cursor:"opaque",hasMore:true,counts:{actionable:20,currentUnread:80},nextExpiryAt:item.currentUntil,serverTime:timestamp};
test("a bounded page preserves whole-scope counts and an unknown original occurrence",()=>{
 assert.deepEqual(currentInboxResponseSchema.parse(response),response);
 assert.equal(currentInboxResponseSchema.safeParse({...response,items:Array.from({length:51},()=>item)}).success,false);
});
test("current identity accepts only opaque supported subjects",()=>{
 for(const value of [id,id.replace("ntf_","sub_"),id.replace("ntf_","act_")])assert.equal(currentSubjectIdSchema.safeParse(value).success,true);
 for(const value of ["my-project","usr_10000000-0000-4000-8000-000000000001","ntf_bad"])assert.equal(currentSubjectIdSchema.safeParse(value).success,false);
});
test("summary limits count Unicode scalars and reject full content fields",()=>{
 assert.equal(currentSubjectProjectionSchema.safeParse({...item,title:"🟢".repeat(200),summary:"🟠".repeat(240)}).success,true);
 assert.equal(currentSubjectProjectionSchema.safeParse({...item,summary:"x".repeat(241)}).success,false);
 assert.equal(currentSubjectProjectionSchema.safeParse({...item,body:"full body"}).success,false);
});
test("retired unknown subjects need no version and targeted responses need no continuation",()=>{
 const targeted={...response,items:[],retired:[{subjectId:id,reason:"not_found"}],cursor:null,hasMore:false};
 assert.deepEqual(currentInboxResponseSchema.parse(targeted),targeted);
 assert.equal(currentInboxResponseSchema.safeParse({...targeted,retired:[{subjectId:id,reason:"unknown_reason"}]}).success,false);
});
test("current hints bound identities and cannot carry message content or replay cursors",()=>{
 assert.deepEqual(currentChangeHintSchema.parse({subjectIds:[],invalidateCounts:true}),{subjectIds:[],invalidateCounts:true});
 assert.equal(currentChangeHintSchema.safeParse({subjectIds:Array(51).fill(id),invalidateCounts:true}).success,false);
 assert.equal(currentChangeHintSchema.safeParse({subjectIds:[id],invalidateCounts:true,body:"secret"}).success,false);
 assert.equal(currentChangeHintSchema.safeParse({subjectIds:[id],invalidateCounts:true,cursor:"replay"}).success,false);
});
