import assert from "node:assert/strict";
import test from "node:test";
import { deckBasis,deckColorState,deckColors,deckReadings,ORB_RAMPS,toward,type DeckNotification } from "../src/index.js";

test("each state paints its ramp; today's biggest other meaning lights the peaks",() => {
  assert.deepEqual(deckColors({},"clear"),ORB_RAMPS.clear);
  assert.deepEqual(deckColors({ running: 2 },"running"),ORB_RAMPS.running);
  assert.deepEqual(deckColors({ running: 2,failed: 1,done: 3 },"running"),["#5ce1ff","#8b7cff","#34d399"]);
  // Ties go to the earlier meaning in display order (done before failed).
  assert.deepEqual(deckColors({ needsYou: 1,failed: 2,done: 2 },"needsYou"),["#ff8a3d","#ff6b57","#34d399"]);
});

test("the colour state: needs you, else work under way (moving or quiet), else clear",() => {
  const summary = (running: string[],quiet: string[] = [],sessions: Array<{ phase: string | null; workId: string | null }> = []) => ({
    running: running.map((state) => ({ owner: { state } })),
    quiet: quiet.map((state) => ({ owner: { state } })),
    sessions: { sessions },
  });
  assert.equal(deckBasis(summary(["moving"])),"moving");
  assert.equal(deckBasis(summary([],[],[{ phase: "working",workId: null }])),"moving");
  assert.equal(deckBasis(summary(["stale"],["no_signal"])),"quiet");
  assert.equal(deckBasis(summary(["paused"])),"calm");
  assert.equal(deckBasis(null),"calm");
  assert.equal(deckColorState(1,"moving"),"needsYou");
  assert.equal(deckColorState(0,"quiet"),"running");
  assert.equal(deckColorState(0,"calm"),"clear");
});

test("quiet work desaturates the running ramp 30%; offline greys every colour 40%",() => {
  assert.deepEqual(deckColors({},"running",{ quiet: true }),ORB_RAMPS.running.map((color) => toward(color,0.3)));
  assert.deepEqual(deckColors({},"clear",{ quiet: true }),ORB_RAMPS.clear);
  assert.deepEqual(deckColors({},"needsYou",{ offline: true }),ORB_RAMPS.needsYou.map((color) => toward(color,0.4)));
  assert.equal(toward("#ffffff",1),"#ffffff");
});

test("readings count today's rows, done and answered, and the finished mix",() => {
  const now = new Date(2026,9,15,15,0,0);
  const today = new Date(2026,9,15,9,0,0).toISOString();
  const yesterday = new Date(2026,9,14,9,0,0).toISOString();
  const card = (outcome: string | null,state = "ended",at = today): DeckNotification => ({
    kind: "live_activity",state: "ended",createdAt: at,activity: { state,outcome,updatedAt: at },
  });
  const rows: DeckNotification[] = [
    card("completed"),
    card("failed"),
    card(null,"active"),
    card("completed","ended",yesterday),
    { kind: "question",state: "delivered",createdAt: today,question: { state: "denied",expiresAt: null } },
    { kind: "question",state: "delivered",createdAt: today,question: { state: "pending",expiresAt: null } },
    { kind: "message",state: "delivered",createdAt: today },
  ];
  assert.deepEqual(deckReadings({ notifications: rows,running: 1,needsYou: 2,now }),{
    today: 6,
    done: 2,
    mix: { done: 1,failed: 1,attention: 1,message: 1,needsYou: 2,running: 1 },
  });
});
