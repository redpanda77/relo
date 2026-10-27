import assert from "node:assert/strict";
import test from "node:test";
import {
  answerPillText,
  HISTORY_ENDINGS,
  historyCounts,
  historyCountsLine,
  historyEndingLabel,
  isSettled,
  quietGap,
  spanLabel,
} from "../src/history.js";

test("History's endings are the iPhone's settled meanings, in its order",()=>{
  assert.deepEqual([...HISTORY_ENDINGS],["done","attention","failed","message"]);
  assert.equal(isSettled("running"),false);
  assert.equal(isSettled("needsYou"),false);
  assert.equal(isSettled("failed"),true);
});

test("each meaning has the iPhone's History word",()=>{
  assert.deepEqual(HISTORY_ENDINGS.map((signal)=>historyEndingLabel(signal,2)),["Done","Ended","Stopped","Messages"]);
  assert.equal(historyEndingLabel("message",1),"Message");
});

test("a day counts only what settled, in display order",()=>{
  const counts=historyCounts(["message","done","running","failed","done","needsYou","attention"]);
  assert.deepEqual(counts,[{signal:"done",count:2},{signal:"attention",count:1},{signal:"failed",count:1},{signal:"message",count:1}]);
  assert.equal(historyCountsLine(counts),"2 done · 1 ended · 1 stopped · 1 message");
  assert.equal(historyCountsLine(historyCounts([])),"");
});

test("spans read as the iPhone reads them",()=>{
  assert.equal(spanLabel(59),null);
  assert.equal(spanLabel(12*60),"12m");
  assert.equal(spanLabel(3*3600),"3h");
  assert.equal(spanLabel(4*3600+12*60),"4h 12m");
});

test("an hour or more between rows is a quiet gap",()=>{
  const hour=3_600_000;
  assert.equal(quietGap(hour-1,0),null);
  assert.equal(quietGap(hour,0),"1h quiet");
  assert.equal(quietGap(3*hour+45*60_000,0),"3h 45m quiet");
});

test("an answer reads as the owner's own words",()=>{
  assert.equal(answerPillText("approved"),"You approved");
  assert.equal(answerPillText("denied"),"You declined");
  assert.equal(answerPillText("replied","Ship it"),"You chose Ship it");
  assert.equal(answerPillText("expired"),"No answer in time");
  assert.equal(answerPillText("canceled"),"Withdrawn");
});
