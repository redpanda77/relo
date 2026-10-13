import assert from "node:assert/strict";
import { test } from "node:test";
import { inboxReadItemsRequestSchema,inboxReadItemsResponseSchema } from "../src/index.js";
const id="ntf_11111111-1111-1111-1111-111111111111";
test("exact read batches are bounded, reject unknown authority and accept duplicate intent",()=>{
  assert.equal(inboxReadItemsRequestSchema.safeParse({notificationIds:[id,id]}).success,true);
  for(const input of [{notificationIds:[]},{notificationIds:Array(251).fill(id)},{notificationIds:["ntf_invalid"]},
    {notificationIds:[id],watermark:"all"}]) assert.equal(inboxReadItemsRequestSchema.safeParse(input).success,false);
});
test("per-ID acknowledgements must be unique and have a classified outcome",()=>{
  const result={notificationId:id,outcome:"already_read"};
  assert.equal(inboxReadItemsResponseSchema.safeParse({results:[result],unread:{account:2500,projects:{}}}).success,true);
  assert.equal(inboxReadItemsResponseSchema.safeParse({results:[result,result],unread:{account:0,projects:{}}}).success,false);
});
