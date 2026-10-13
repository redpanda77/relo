import { afterAll,beforeAll,describe,expect,test } from "vitest";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { registrationMode,setRegistrationMode } from "./server-accounts.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("open registration on a public origin (HARDENING gap 6)",() => {
  let db: Database;
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); });
  afterAll(async () => {
    await db.query("UPDATE server_settings SET registration_mode='closed'");
    await db.end();
  });

  test("a saved Open acts as Approval on a public address and stays Open on a private one",async () => {
    await setRegistrationMode(db,"open");
    expect(await registrationMode(db,"https://relo.example.com")).toBe("approval");
    for (const privateOrigin of ["http://localhost:8180","https://relo.tail1234.ts.net:8180","https://192.168.1.10","https://relo.lan"]) {
      expect(await registrationMode(db,privateOrigin)).toBe(privateOrigin.includes("ts.net") ? "approval" : "open");
    }
    expect(await registrationMode(db)).toBe("open");
    await setRegistrationMode(db,"closed");
    expect(await registrationMode(db,"https://relo.example.com")).toBe("closed");
  });
});
