import { createHash,randomBytes,randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import {
  AGENT_SESSION_WAITING_AFTER_STOP_SECONDS,AGENT_SESSION_WAITING_ON_PROMPT_SECONDS,agentSessionListResponseSchema,
  agentSessionPhase,inboxSnapshotResponseSchema,
} from "@relo/notification-contracts";
import { createApp } from "./app.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { expireDueActivities } from "./activities.js";
import { expireDueInteractiveActivities } from "./interactive-activity-lifecycle.js";
import {
  SESSION_IDLE_LOST_AFTER_SECONDS,SESSION_LIST_MAX,SESSION_LOST_AFTER_SECONDS,SESSION_LOST_CARD_GRACE_SECONDS,
  listAgentSessions,readAgentSessions,reconcileAgentSessions,
} from "./agent-sessions.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Agent sessions: events, read model and the reconciler",() => {
  let db: Database,principalId: string,app: ReturnType<typeof createApp>;
  const owner = "agent_sessions_owner_abcdefghijklmnopqrstuvwxyz";
  const secret = "agent-sessions-secret-with-at-least-32-characters";
  const context = { providerName: "Claude Code",project: "relo",threadName: "Release" };
  const sessionHash = (id: string) => createHash("sha256").update(`claude-code\0${id}`).digest("hex");
  const cardKeyFor = (hash: string) => `session-claude-code-${hash.slice(0,24)}`;
  const S1 = sessionHash("one");

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret });
  });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE"); await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });

  async function request(method: string,path: string,body?: unknown,token: string | null = owner) {
    const response = await app.request(path,{
      method,headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),"content-type": "application/json",
        "idempotency-key": randomUUID() },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any,headers: response.headers };
  }
  const event = (body: Record<string,unknown>,token: string | null = owner) =>
    request("POST","/api/agent-sessions/events",{ session: S1,harness: "claude-code",...body },token);
  const row = async (hash = S1) => (await db.query("SELECT * FROM agent_sessions WHERE session_hash=$1",[hash])).rows[0];
  async function keyWith(scopes: string[]) {
    const token = generateToken();
    await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash,scopes) VALUES ($1,$2,$3,$4)",
      [principalId,`k-${randomUUID()}`,hashToken(token),scopes]);
    return token;
  }
  async function phone() {
    return (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token,
      live_activity_push_to_start_token) VALUES ($1,$2,$3,'Phone','com.example.relo.notifications','1','1','26','sandbox',
      'authorized','authorized','fixture-alert','fixture-start') RETURNING id`,
    [principalId,randomUUID(),randomUUID()])).rows[0]!.id;
  }
  const startCard = async (key: string) => {
    const response = await request("POST","/api/live-activities",{ key,acquireMode: "ensure",title: "Release",status: "Working",context });
    expect(response.status).toBe(201);
    return response.body.activity.id as string;
  };
  const cardRow = async (key: string) => (await db.query("SELECT * FROM live_activities WHERE activity_key=$1",[key])).rows[0];
  const ago = (hash: string,seconds: number) => db.query(
    "UPDATE agent_sessions SET last_event_at=now()-make_interval(secs=>$2::double precision) WHERE session_hash=$1",[hash,seconds]);
  const SESSION_SILENCE_FOR_CARD_END = SESSION_LOST_AFTER_SECONDS+SESSION_LOST_CARD_GRACE_SECONDS+60;
  const reconcile = () => reconcileAgentSessions(db,"sandbox");

  describe("POST /api/agent-sessions/events",() => {
    test("stores a session and answers compactly",async () => {
      const posted = await event({ event: "start",project: "relo",computer: "mac",account: "work",cardKey: cardKeyFor(S1) });
      expect(posted).toMatchObject({ status: 200,body: { ok: true,state: "active" } });
      expect(Object.keys(posted.body).sort()).toEqual(["ok","state"]);
      expect(await row()).toMatchObject({ harness: "claude-code",project: "relo",computer: "mac",account: "work",
        state: "active",last_event: "start",card_key: cardKeyFor(S1),ended_at: null });
      expect((await event({ event: "stop" })).body.state).toBe("idle");
      expect((await event({ event: "prompt" })).body.state).toBe("active");
      expect((await row()).project).toBe("relo");
    });

    test("rejects anything outside the bounded labels",async () => {
      const bad: Record<string,unknown>[] = [
        { event: "start",session: "short" },
        { event: "start",session: `${"a".repeat(129)}` },
        { event: "start",session: "has spaces in it 123456" },
        { event: "pause" },
        { event: "start",harness: "Claude Code" },
        { event: "start",harness: "a".repeat(41) },
        { event: "start",project: "x".repeat(121) },
        { event: "start",computer: "x".repeat(121) },
        { event: "start",account: "x".repeat(41) },
        { event: "start",cardKey: "x".repeat(101) },
        { event: "start",project: "line\nbreak" },
        { event: "start",at: "yesterday" },
        { event: "start",prompt: "free text" },
        { event: "start",transcript: "/tmp/x" },
      ];
      for (const body of bad) {
        const response = await event(body);
        expect(response.status,JSON.stringify(body)).toBe(400);
        expect(response.body.error).toBe("invalid_request");
      }
      expect((await request("POST","/api/agent-sessions/events","{not json")).status).toBe(400);
      expect((await db.query("SELECT count(*)::int AS n FROM agent_sessions")).rows[0].n).toBe(0);
    });

    test("accepts a base64url session hash",async () => {
      const hash = createHash("sha256").update("x").digest("base64url");
      expect((await event({ session: hash,event: "start" })).status).toBe(200);
    });

    test("scopes: sessions:write and activities:write write; others, phones and strangers do not",async () => {
      expect((await event({ event: "start" },null)).status).toBe(401);
      expect((await event({ event: "start" },await keyWith(["notifications:send"]))).status).toBe(403);
      expect((await event({ event: "start" },await keyWith(["sessions:write"]))).status).toBe(200);
      expect((await event({ event: "start" },await keyWith(["activities:write"]))).status).toBe(200);
      const device = await phone();
      const credential = generateToken();
      await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['inbox:read','activities:write'])",
        [device,hashToken(credential)]);
      expect((await event({ event: "start" },credential)).status).toBe(403);
      // New keys carry the scope by default.
      expect((await db.query("SELECT scopes FROM principal_api_keys WHERE token_hash=$1",[hashToken(owner)])).rows[0].scopes)
        .toContain("sessions:write");
    });

    test("reading needs activities:read or sessions:write",async () => {
      await event({ event: "start" });
      expect((await request("GET","/api/agent-sessions",undefined,await keyWith(["notifications:send"]))).status).toBe(403);
      expect((await request("GET","/api/agent-sessions",undefined,null)).status).toBe(401);
      for (const scope of ["activities:read","sessions:write"]) {
        const read = await request("GET","/api/agent-sessions",undefined,await keyWith([scope]));
        expect(read.status).toBe(200);
        expect(agentSessionListResponseSchema.parse(read.body).sessions).toHaveLength(1);
      }
    });

    test("is rate limited per credential",async () => {
      const token = await keyWith(["sessions:write"]);
      let last = 200;
      for (let i = 0; i < 121 && last === 200; i += 1) last = (await event({ event: "tool" },token)).status;
      expect(last).toBe(429);
      const limited = await event({ event: "tool" },token);
      expect(limited.body).toMatchObject({ error: "rate_limited",scope: "client" });
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      // Another credential of the account still writes.
      expect((await event({ event: "tool" },await keyWith(["sessions:write"]))).status).toBe(200);
    });

    test("is idempotent and ignores events older than the newest seen",async () => {
      const now = Date.now();
      const t = (minutes: number) => new Date(now-minutes*60_000).toISOString();
      await event({ event: "start",at: t(10) });
      await event({ event: "prompt",at: t(5) });
      const before = await row();
      for (let i = 0; i < 3; i += 1) expect((await event({ event: "prompt",at: t(5) })).body).toEqual({ ok: true,state: "active" });
      expect(await db.query("SELECT 1 FROM agent_sessions")).toHaveProperty("rowCount",1);
      expect((await row()).last_event_at).toEqual(before.last_event_at);
      // An older stop arrives late: state and time do not move.
      expect((await event({ event: "stop",at: t(7) })).body.state).toBe("active");
      expect(await row()).toMatchObject({ state: "active",last_event: "prompt" });
      expect((await row()).last_event_at).toEqual(before.last_event_at);
      // A newer one applies.
      expect((await event({ event: "stop",at: t(1) })).body.state).toBe("idle");
    });

    test("end finishes the session; stale or late events do not revive it, a newer start does",async () => {
      const now = Date.now();
      const t = (minutes: number) => new Date(now-minutes*60_000).toISOString();
      await event({ event: "start",at: t(10) });
      expect((await event({ event: "end",at: t(5) })).body.state).toBe("ended");
      const ended = await row();
      expect(ended).toMatchObject({ state: "ended",ended_reason: "session_end" });
      expect(ended.ended_at).toEqual(ended.last_event_at);
      expect((await event({ event: "end",at: t(5) })).body.state).toBe("ended");
      expect((await event({ event: "tool",at: t(5) })).body.state).toBe("ended");
      expect((await event({ event: "tool",at: t(8) })).body.state).toBe("ended");
      expect((await event({ event: "stop",at: t(1) })).body.state).toBe("ended");
      expect((await row()).ended_at).toEqual(ended.ended_at);
      expect((await event({ event: "start",at: t(1) })).body.state).toBe("active");
      expect(await row()).toMatchObject({ state: "active",ended_at: null,ended_reason: null });
    });

    test("a future timestamp is clamped to the server clock",async () => {
      await event({ event: "start",at: new Date(Date.now()+86_400_000).toISOString() });
      const seconds = (await db.query("SELECT extract(epoch FROM last_event_at-now()) AS s FROM agent_sessions")).rows[0].s;
      expect(Number(seconds)).toBeLessThan(310);
    });
  });

  describe("reconciler",() => {
    async function sessionWithCard(hash = S1) {
      await phone();
      const key = cardKeyFor(hash);
      const id = await startCard(key);
      await event({ session: hash,event: "start",cardKey: key });
      await event({ session: hash,event: "prompt" });
      return { key,id };
    }
    const operations = async (activityId: string) => (await db.query(
      "SELECT operation FROM live_activity_operations WHERE live_activity_id=$1 AND operation='end'",[activityId.slice(4)])).rowCount;

    test("ended session with an active card and no question ends the card",async () => {
      const { key,id } = await sessionWithCard();
      await event({ event: "end" });
      expect(await reconcile()).toMatchObject({ cardsEnded: 1 });
      expect(await cardRow(key)).toMatchObject({ state: "ended",status: "Session ended",terminal_reason: "session_ended",
        terminal_actor: "session",terminal_policy: "session_reconciler" });
      expect(await operations(id)).toBe(1);
      // End pushes were queued for the phone through the normal path.
      expect((await db.query("SELECT count(*)::int AS n FROM notification_events WHERE payload#>>'{liveActivity,operation}'='end'"))
        .rows[0].n).toBeGreaterThan(0);
      // Idempotent.
      expect(await reconcile()).toEqual({ lost: 0,cardsEnded: 0,pruned: 0 });
      expect(await operations(id)).toBe(1);
    });

    test("ended session with an open question leaves the card; the pass after the question settles ends it",async () => {
      const { key,id } = await sessionWithCard();
      const asked = await request("POST",`/api/live-activities/${id}/wait`,{ type: "yes_no",prompt: "Continue?" });
      expect(asked.status).toBe(201);
      await event({ event: "end" });
      expect(await reconcile()).toMatchObject({ cardsEnded: 0 });
      expect((await cardRow(key)).state).toBe("active");
      // The owner's answer settles the request and clears the held card.
      await db.query("UPDATE interaction_requests SET state='approved',responded_at=now()");
      await db.query("UPDATE live_activities SET resume_presentation=NULL WHERE activity_key=$1",[key]);
      expect(await reconcile()).toMatchObject({ cardsEnded: 1 });
      expect(await cardRow(key)).toMatchObject({ state: "ended",status: "Session ended" });
    });

    test("an unanswered question that expires ends the card through the existing path first",async () => {
      const { key,id } = await sessionWithCard();
      await request("POST",`/api/live-activities/${id}/wait`,{ type: "yes_no",prompt: "Continue?" });
      await event({ event: "end" });
      await db.query("UPDATE interaction_requests SET expires_at=clock_timestamp()-interval '1 second'");
      await expireDueInteractiveActivities(db,"sandbox");
      expect((await cardRow(key)).state).toBe("expired");
      expect(await reconcile()).toMatchObject({ cardsEnded: 0 });
      expect((await cardRow(key)).state).toBe("expired");
    });

    test("silence for the lost threshold marks the session lost; its card ends after the grace period",async () => {
      const { key } = await sessionWithCard();
      await ago(S1,SESSION_LOST_AFTER_SECONDS-60);
      expect(await reconcile()).toEqual({ lost: 0,cardsEnded: 0,pruned: 0 });
      expect((await row()).state).toBe("active");
      await ago(S1,SESSION_LOST_AFTER_SECONDS+60);
      expect(await reconcile()).toEqual({ lost: 1,cardsEnded: 0,pruned: 0 });
      expect(await row()).toMatchObject({ state: "lost",ended_reason: "lost" });
      expect((await cardRow(key)).state).toBe("active");
      // Still inside the grace period.
      await ago(S1,SESSION_LOST_AFTER_SECONDS+SESSION_LOST_CARD_GRACE_SECONDS-60);
      await db.query("UPDATE agent_sessions SET ended_at=last_event_at+make_interval(secs=>$1::double precision)",[SESSION_LOST_AFTER_SECONDS]);
      expect(await reconcile()).toMatchObject({ cardsEnded: 0 });
      expect((await cardRow(key)).state).toBe("active");
      await ago(S1,SESSION_LOST_AFTER_SECONDS+SESSION_LOST_CARD_GRACE_SECONDS+60);
      await db.query("UPDATE agent_sessions SET ended_at=last_event_at+make_interval(secs=>$1::double precision)",[SESSION_LOST_AFTER_SECONDS]);
      expect(await reconcile()).toMatchObject({ cardsEnded: 1 });
      expect(await cardRow(key)).toMatchObject({ state: "ended",status: "Session lost",terminal_reason: "session_lost" });
    });

    test("an idle session waiting for the owner is not lost after the turn threshold, only after the idle one",async () => {
      await sessionWithCard();
      await event({ event: "stop" });
      await ago(S1,SESSION_LOST_AFTER_SECONDS+600);
      expect(await reconcile()).toEqual({ lost: 0,cardsEnded: 0,pruned: 0 });
      expect((await row()).state).toBe("idle");
      expect((await listAgentSessions(db,principalId))[0]).toMatchObject({ state: "idle" });
      await ago(S1,SESSION_IDLE_LOST_AFTER_SECONDS+60);
      expect((await listAgentSessions(db,principalId))[0]).toMatchObject({ state: "lost",presence: "lost" });
      expect(await reconcile()).toMatchObject({ lost: 1 });
      const stored = await row();
      expect(stored.state).toBe("lost");
      // Lost when the idle threshold passed, so the card's grace period counts from then.
      expect(new Date(stored.ended_at).getTime()-new Date(stored.last_event_at).getTime()).toBe(SESSION_IDLE_LOST_AFTER_SECONDS*1000);
    });

    test("an idle session does not hold its stale card: the ordinary expiry ends it",async () => {
      const { key } = await sessionWithCard();
      await event({ event: "stop" });
      await db.query("UPDATE live_activities SET stale_at=clock_timestamp()-interval '11 minutes' WHERE activity_key=$1",[key]);
      expect(await expireDueActivities(db,"sandbox")).toBe(1);
      expect((await cardRow(key)).state).toBe("expired");
    });

    test("a state change wakes the current-state stream; a tool event does not",async () => {
      const client = await db.connect();
      const hints: string[] = [];
      client.on("notification",message => { if (message.channel === "relo_current_changes") hints.push(message.payload ?? ""); });
      try {
        await client.query("LISTEN relo_current_changes");
        await event({ event: "start",at: new Date(Date.now()-3_000).toISOString() });
        await event({ event: "tool",at: new Date(Date.now()-2_000).toISOString() });
        await event({ event: "stop",at: new Date(Date.now()-1_000).toISOString() });
        await new Promise(resolve => setTimeout(resolve,200));
        expect(hints.map(hint => JSON.parse(hint))).toEqual([
          { principalId,subjectId: null },{ principalId,subjectId: null },
        ]);
      } finally {
        await client.query("UNLISTEN relo_current_changes");
        client.release();
      }
    });

    test("a lost session with an open question keeps its card",async () => {
      const { key,id } = await sessionWithCard();
      await request("POST",`/api/live-activities/${id}/wait`,{ type: "yes_no",prompt: "Continue?" });
      await ago(S1,SESSION_LOST_AFTER_SECONDS+SESSION_LOST_CARD_GRACE_SECONDS+600);
      await reconcile(); await reconcile();
      expect(await row()).toMatchObject({ state: "lost" });
      expect((await cardRow(key)).state).toBe("active");
    });

    test("a lost session that speaks again is active and keeps its card",async () => {
      const { key } = await sessionWithCard();
      await ago(S1,SESSION_LOST_AFTER_SECONDS+60);
      await reconcile();
      expect((await row()).state).toBe("lost");
      await event({ event: "tool" });
      expect(await row()).toMatchObject({ state: "active",ended_at: null });
      expect(await reconcile()).toEqual({ lost: 0,cardsEnded: 0,pruned: 0 });
      expect((await cardRow(key)).state).toBe("active");
    });

    test("an active session whose card went stale is quiet and its card is not ended by the session rules",async () => {
      const { key,id } = await sessionWithCard();
      await db.query("UPDATE live_activities SET stale_at=clock_timestamp()-interval '3 minutes',updated_at=clock_timestamp()-interval '14 minutes' WHERE activity_key=$1",[key]);
      expect(await reconcile()).toEqual({ lost: 0,cardsEnded: 0,pruned: 0 });
      expect((await cardRow(key)).state).toBe("active");
      const [session] = await listAgentSessions(db,principalId);
      expect(session).toMatchObject({ state: "active",presence: "quiet",card: { id,state: "active" } });
      expect(session!.card!.quietForSeconds).toBeGreaterThanOrEqual(14*60);
      expect(session!.card!.quietForSeconds).toBeLessThan(15*60);
    });

    test("a live session keeps its stale card past the ten-minute expiry; stale_at is untouched",async () => {
      const { key } = await sessionWithCard();
      await db.query("UPDATE live_activities SET stale_at=clock_timestamp()-interval '30 minutes' WHERE activity_key=$1",[key]);
      const staleAt = (await cardRow(key)).stale_at;
      expect(await expireDueActivities(db,"sandbox")).toBe(0);
      expect(await cardRow(key)).toMatchObject({ state: "active",stale_at: staleAt });
      expect((await listAgentSessions(db,principalId))[0]).toMatchObject({ presence: "quiet" });
      // The session goes silent: lost, then the card ends after the grace period.
      await ago(S1,SESSION_LOST_AFTER_SECONDS+60);
      await reconcile();
      expect(await expireDueActivities(db,"sandbox")).toBe(1);
      expect((await cardRow(key)).state).toBe("expired");
    });

    test("a lost session's stale card ends through the session rules after the grace period",async () => {
      const { key } = await sessionWithCard();
      await db.query("UPDATE live_activities SET stale_at=clock_timestamp()-interval '30 minutes' WHERE activity_key=$1",[key]);
      await ago(S1,SESSION_SILENCE_FOR_CARD_END);
      await reconcile();
      expect(await cardRow(key)).toMatchObject({ state: "ended",status: "Session lost" });
    });

    test("the hard expiry still ends a live session's card",async () => {
      const { key } = await sessionWithCard();
      await db.query("UPDATE live_activities SET stale_at=clock_timestamp()-interval '30 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE activity_key=$1",[key]);
      expect(await expireDueActivities(db,"sandbox")).toBe(1);
      expect((await cardRow(key)).state).toBe("expired");
    });

    test("an active session with a fresh card is working",async () => {
      const { id } = await sessionWithCard();
      const [session] = await listAgentSessions(db,principalId);
      expect(session).toMatchObject({ presence: "working",card: { id } });
      expect(session!.card!.quietForSeconds).toBeLessThan(5);
    });

    test("an active session without a card is listed as no_card and nothing is pushed",async () => {
      await phone();
      await event({ event: "start",cardKey: cardKeyFor(S1) });
      await event({ session: sessionHash("nokey"),event: "start" });
      const before = (await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n;
      expect(await reconcile()).toEqual({ lost: 0,cardsEnded: 0,pruned: 0 });
      expect((await listAgentSessions(db,principalId)).map(session => [session.presence,session.card])).toEqual([["no_card",null],["no_card",null]]);
      expect((await db.query("SELECT count(*)::int AS n FROM notification_events")).rows[0].n).toBe(before);
    });

    test("a card that already ended or expired is not ended again",async () => {
      const { key,id } = await sessionWithCard();
      await ago(S1,SESSION_LOST_AFTER_SECONDS+60);
      await db.query("UPDATE live_activities SET stale_at=clock_timestamp()-interval '11 minutes' WHERE activity_key=$1",[key]);
      await expireDueActivities(db,"sandbox");
      expect((await cardRow(key)).state).toBe("expired");
      const sequence = (await cardRow(key)).sequence;
      await event({ event: "end" });
      expect(await reconcile()).toMatchObject({ cardsEnded: 0 });
      expect(await cardRow(key)).toMatchObject({ state: "expired",sequence });
      expect(await operations(id)).toBe(1);
      expect((await listAgentSessions(db,principalId))[0]).toMatchObject({ presence: "ended",card: null });
    });

    test("only the account's own card is ended, never one that shares a key with another account",async () => {
      const { key } = await sessionWithCard();
      const other = (await db.query("INSERT INTO owner_principals(handle) VALUES ('other') RETURNING id")).rows[0].id;
      await db.query("INSERT INTO agent_sessions(principal_id,session_hash,harness,state,started_at,last_event_at,last_event,card_key) VALUES ($1,$2,'claude-code','ended',now(),now(),'end',$3)",
        [other,sessionHash("foreign"),key]);
      expect(await reconcile()).toMatchObject({ cardsEnded: 0 });
      expect((await cardRow(key)).state).toBe("active");
    });

    test("settled sessions are removed after the retention period",async () => {
      await event({ event: "start" }); await event({ event: "end" });
      await db.query("UPDATE agent_sessions SET last_event_at=now()-interval '8 days'");
      expect(await reconcile()).toMatchObject({ pruned: 1 });
      expect(await row()).toBeUndefined();
    });
  });

  describe("phases: working, waiting, idle",() => {
    const phaseOf = async (hash = S1) => {
      const id = `ags_${(await row(hash)).id}`;
      return (await listAgentSessions(db,principalId)).find(session => session.id === id)?.phase;
    };

    test("a prompt or tool is working; a stop waits five minutes, then is idle",async () => {
      await event({ event: "prompt" });
      expect(await phaseOf()).toBe("working");
      await event({ event: "stop" });
      expect(await phaseOf()).toBe("waiting");
      await ago(S1,AGENT_SESSION_WAITING_AFTER_STOP_SECONDS+5);
      expect(await phaseOf()).toBe("idle");
      await event({ event: "tool" });
      expect(await phaseOf()).toBe("working");
    });

    test("a permission or input prompt (wait) is waiting for an hour, stored between turns",async () => {
      await event({ event: "prompt" });
      expect((await event({ event: "wait" })).body.state).toBe("idle");
      expect(await row()).toMatchObject({ state: "idle",last_event: "wait" });
      await ago(S1,AGENT_SESSION_WAITING_ON_PROMPT_SECONDS-60);
      expect(await phaseOf()).toBe("waiting");
      await ago(S1,AGENT_SESSION_WAITING_ON_PROMPT_SECONDS+60);
      expect(await phaseOf()).toBe("idle");
      // A wait never revives an ended session.
      await event({ event: "end" });
      expect((await event({ event: "wait" })).body.state).toBe("ended");
    });

    test("a session that only started is idle and is not lost after the mid-turn threshold",async () => {
      await event({ event: "start" });
      expect(await phaseOf()).toBe("idle");
      await ago(S1,SESSION_LOST_AFTER_SECONDS+60);
      expect(await reconcile()).toMatchObject({ lost: 0 });
      expect(await phaseOf()).toBe("idle");
      await ago(S1,SESSION_IDLE_LOST_AFTER_SECONDS+60);
      expect(await phaseOf()).toBe("lost");
      expect(await reconcile()).toMatchObject({ lost: 1 });
    });

    test("a start in the middle of a turn (after a compaction) keeps it working; after a stop it is idle",async () => {
      await event({ event: "tool" });
      await event({ event: "start" });
      expect(await row()).toMatchObject({ state: "active",last_event: "tool" });
      expect(await phaseOf()).toBe("working");
      await event({ event: "stop" });
      await event({ event: "start" });
      expect(await row()).toMatchObject({ state: "active",last_event: "start" });
      expect(await phaseOf()).toBe("idle");
    });

    test("?phase= lists only those phases, live first; counts cover every phase; a bad phase is a 400",async () => {
      const [working,waiting,idle,ended] = ["w","x","i","e"].map(sessionHash);
      await event({ session: working,event: "tool" });
      await event({ session: waiting,event: "stop" });
      await event({ session: idle,event: "stop" }); await ago(idle,AGENT_SESSION_WAITING_AFTER_STOP_SECONDS+5);
      await event({ session: ended,event: "end" });
      const all = await request("GET","/api/agent-sessions");
      expect(all.body.sessions.map((session: any) => session.phase)).toEqual(["working","waiting","idle","ended"]);
      const live = await request("GET","/api/agent-sessions?phase=working,waiting");
      expect(live.status).toBe(200);
      expect(agentSessionListResponseSchema.parse(live.body).sessions.map(session => session.phase)).toEqual(["working","waiting"]);
      expect(live.body.counts).toEqual({ working: 1,waiting: 1,idle: 1,ended: 1,lost: 0 });
      expect((await request("GET","/api/agent-sessions?phase=idle")).body.sessions).toHaveLength(1);
      expect((await request("GET","/api/agent-sessions?phase=asleep")).status).toBe(400);
      expect((await request("GET","/api/agent-sessions?other=1")).status).toBe(400);
    });

    test("the server's phase and the shared rule agree",async () => {
      for (const [hash,events,seconds] of [
        [sessionHash("a"),["prompt"],0],[sessionHash("b"),["stop"],60],[sessionHash("c"),["stop"],AGENT_SESSION_WAITING_AFTER_STOP_SECONDS+60],
        [sessionHash("d"),["wait"],600],[sessionHash("e"),["start"],0],[sessionHash("f"),["end"],0],
      ] as const) {
        for (const name of events) await event({ session: hash,event: name });
        await ago(hash,seconds);
      }
      for (const session of await listAgentSessions(db,principalId)) {
        expect(agentSessionPhase(session,Date.now())).toBe(session.phase);
      }
    });

    test("a wait after a stop wakes the current-state stream; a second wait does not",async () => {
      await event({ event: "stop",at: new Date(Date.now()-3_000).toISOString() });
      const client = await db.connect();
      const hints: string[] = [];
      client.on("notification",message => { if (message.channel === "relo_current_changes") hints.push(message.payload ?? ""); });
      try {
        await client.query("LISTEN relo_current_changes");
        await event({ event: "wait",at: new Date(Date.now()-2_000).toISOString() });
        await event({ event: "wait",at: new Date(Date.now()-1_000).toISOString() });
        await new Promise(resolve => setTimeout(resolve,200));
        expect(hints).toHaveLength(1);
      } finally {
        await client.query("UNLISTEN relo_current_changes");
        client.release();
      }
    });
  });

  describe("read model and exposure",() => {
    test("lists the last 24 hours, at most 20, live sessions first, with a silent session reading as lost",async () => {
      for (let i = 0; i < SESSION_LIST_MAX+4; i += 1) {
        await event({ session: sessionHash(`many-${i}`),event: "prompt",computer: `mac-${i}` });
      }
      await event({ session: sessionHash("old"),event: "start" });
      await db.query("UPDATE agent_sessions SET last_event_at=now()-interval '25 hours' WHERE session_hash=$1",[sessionHash("old")]);
      await event({ session: sessionHash("ended"),event: "start" }); await event({ session: sessionHash("ended"),event: "end" });
      await ago(sessionHash("many-0"),SESSION_LOST_AFTER_SECONDS+30);
      const read = await readAgentSessions(db,principalId);
      const listed = read.sessions;
      expect(listed).toHaveLength(SESSION_LIST_MAX);
      expect(listed.some(session => session.computer === "mac-0")).toBe(false);
      expect(agentSessionListResponseSchema.parse(read).sessions).toHaveLength(SESSION_LIST_MAX);
      expect(read.counts).toEqual({ working: SESSION_LIST_MAX+3,waiting: 0,idle: 0,ended: 1,lost: 1 });
      expect(listed.every(session => session.state === "active")).toBe(true);
      await db.query("DELETE FROM agent_sessions WHERE session_hash NOT IN ($1,$2)",[sessionHash("many-0"),sessionHash("ended")]);
      expect((await listAgentSessions(db,principalId)).map(session => session.state)).toEqual(["ended","lost"]);
    });

    test("has the documented JSON shape",async () => {
      await phone();
      const key = cardKeyFor(S1);
      const id = await startCard(key);
      await event({ event: "start",project: "relo",computer: "mac",account: "work",cardKey: key });
      await event({ event: "prompt" });
      const { body } = await request("GET","/api/agent-sessions");
      expect(body.sessions).toHaveLength(1);
      expect(body.counts).toEqual({ working: 1,waiting: 0,idle: 0,ended: 0,lost: 0 });
      expect(body.sessions[0]).toEqual({
        id: expect.stringMatching(/^ags_[0-9a-f-]{36}$/),harness: "claude-code",computer: "mac",account: "work",project: "relo",
        state: "active",phase: "working",lastEvent: "prompt",startedAt: expect.any(String),lastEventAt: expect.any(String),
        card: { id,state: "active",quietForSeconds: expect.any(Number) },presence: "working",
      });
    });

    test("the inbox snapshot a phone reads carries the sessions",async () => {
      const device = await phone();
      const credential = generateToken();
      await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['inbox:read'])",[device,hashToken(credential)]);
      await event({ event: "start",computer: "mac" });
      const snapshot = inboxSnapshotResponseSchema.parse((await request("GET","/api/inbox/snapshot",undefined,credential)).body);
      expect(snapshot.sessions).toHaveLength(1);
      expect(snapshot.sessions[0]).toMatchObject({ computer: "mac",presence: "no_card",state: "active" });
    });

    test("sealed session names reach the phone's snapshot only, as stored",async () => {
      const bytes = (n: number) => randomBytes(n).toString("base64url");
      const names = { v: "relo.e2e.v1",kind: "names",context: "ses:abc",sender: `k_${bytes(16)}`,
        recipients: [{ device: "dev_1",prekey: "pk_1",enc: bytes(65),key: bytes(48) }],nonce: bytes(12),ct: bytes(272),sig: bytes(64) };
      expect((await event({ event: "start",project: "p-aaaaaaaaaaaaaaaa",sealedNames: { ...names,kind: "notice" } })).status).toBe(400);
      expect((await event({ event: "start",project: "p-aaaaaaaaaaaaaaaa",sealedNames: { ...names,ct: "short" } })).status).toBe(400);
      expect((await event({ event: "start",project: "p-aaaaaaaaaaaaaaaa",sealedNames: names })).status).toBe(200);
      expect((await event({ event: "tool" })).status).toBe(200);
      const device = await phone();
      const credential = generateToken();
      await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['inbox:read'])",[device,hashToken(credential)]);
      const snapshot = inboxSnapshotResponseSchema.parse((await request("GET","/api/inbox/snapshot",undefined,credential)).body);
      expect(snapshot.sessions[0]!.sealedNames).toEqual(names);
      const listed = await request("GET","/api/agent-sessions");
      expect(listed.body.sessions[0].sealedNames).toBeUndefined();
    });

    test("another account never sees the sessions",async () => {
      await event({ event: "start",computer: "mac-private" });
      const other = (await db.query("INSERT INTO owner_principals(handle) VALUES ('other2') RETURNING id")).rows[0].id;
      const token = generateToken();
      await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash) VALUES ($1,'k',$2)",[other,hashToken(token)]);
      const read = await request("GET","/api/agent-sessions",undefined,token);
      expect(read.body).toEqual({ sessions: [],counts: { working: 0,waiting: 0,idle: 0,ended: 0,lost: 0 } });
      // The same hash on another account is its own session.
      expect((await request("POST","/api/agent-sessions/events",{ session: S1,harness: "codex",event: "start" },token)).status).toBe(200);
      expect((await db.query("SELECT count(*)::int AS n FROM agent_sessions")).rows[0].n).toBe(2);
    });
  });
});
