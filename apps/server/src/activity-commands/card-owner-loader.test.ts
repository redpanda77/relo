import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { createDatabase,type Database } from "../db.js";
import { deriveOwnerState } from "../derive/owner-state.js";
import { migrate } from "../migrate.js";
import { caller,resetOwner,SECRET,SESSION_A,startWork } from "../works/works-fixture.js";
import { cardOwnerInput } from "./card-owner.js";

/**
 * The owner state pushed with a card command is derived from the loader (hook evidence of the
 * card's own session, the work's waiting, seen times), not from the card row alone; hooks optional.
 */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("card owner from the owner-state loader",() => {
  let db: Database,principalId: string,call: ReturnType<typeof caller>;
  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    call = caller(createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: SECRET }));
  });
  afterAll(async () => db.end());
  beforeEach(async () => { ({ principalId } = await resetOwner(db)); });

  const card = async () => (await db.query("SELECT * FROM live_activities WHERE work_id IS NOT NULL AND state='active'")).rows[0];
  const hook = (session: string,phase: string) => db.query(
    `INSERT INTO agent_sessions (principal_id,session_hash,harness,phase,phase_since,last_seen_at,started_at,seq)
     VALUES ($1,$2,'claude-code',$3,now()+interval '1 second',now()+interval '1 second',now(),1)`,[principalId,session,phase]);

  test("without hooks: declared evidence only, never an observed state",async () => {
    await startWork(call);
    const input = await cardOwnerInput(db,await card(),"update");
    expect(input.evidence).toEqual({ producer: "agent_session",session: null });
    expect(deriveOwnerState(input).state).toBe("moving");
  });

  test("with hooks: the session's permission prompt makes the card need you",async () => {
    await startWork(call);
    await hook(SESSION_A,"waiting");
    const input = await cardOwnerInput(db,await card(),"update",new Date(Date.now() + 5_000));
    expect(input.evidence.producer === "agent_session" && input.evidence.session?.phase).toBe("waiting");
    expect(deriveOwnerState(input)).toMatchObject({ state: "needs_you",needsYou: "permission" });
  });

  test("another session's observed state never reaches this card",async () => {
    await startWork(call);
    await hook("sessionOTHERxxxxxxxxxxxxxxxxxxxx","waiting");
    const input = await cardOwnerInput(db,await card(),"update");
    expect(input.evidence).toEqual({ producer: "agent_session",session: null });
  });

  test("the work's declared waiting reaches the pushed state; an end clears it",async () => {
    const work = await startWork(call);
    await call("PATCH",`/api/session/works/${work.id}`,{ waiting: { reason: { readable: "CI run" } } });
    const row = await card();
    expect((await cardOwnerInput(db,row,"update")).work.waitingSince).not.toBeNull();
    const ended = await cardOwnerInput(db,row,"end");
    expect(ended.work.waitingSince).toBeNull();
    expect(ended.work.lifecycle).not.toBe("open");
  });
});
