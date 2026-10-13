import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  allowsPrivateCallbacks,callbackSignature,callbackUrlSchema,classifyAddress,resolveCallbackTarget,sendPinnedCallback,
} from "./callback-destinations.js";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";

describe("callback destinations", () => {
  test("classifies the server's own and reserved addresses as never reachable", () => {
    for (const address of ["127.0.0.1","0.0.0.0","169.254.169.254","::1","::","fe80::1","224.0.0.1","::ffff:127.0.0.1","192.0.2.10"]) {
      expect(classifyAddress(address),address).toBe("blocked");
    }
    for (const address of ["10.1.2.3","172.20.0.5","192.168.1.20","100.101.102.103","fd7a:115c:a1e0::1","::ffff:10.0.0.1"]) {
      expect(classifyAddress(address),address).toBe("private");
    }
    for (const address of ["93.184.216.34","2606:2800:220:1::1"]) expect(classifyAddress(address),address).toBe("public");
  });

  test("a callback URL is https, or http for a private network, without credentials or fragments", () => {
    for (const url of ["https://ci.example.com/relo","http://ci.internal/relo","http://10.0.0.5:8080/hook","https://100.64.0.1/x"]) {
      expect(callbackUrlSchema.safeParse(url).success,url).toBe(true);
    }
    for (const url of ["ftp://ci.example.com","https://user:pass@ci.example.com","https://ci.example.com/#x",
      "http://127.0.0.1/x","http://localhost:3000/x","https://169.254.169.254/latest"]) {
      expect(callbackUrlSchema.safeParse(url).success,url).toBe(false);
    }
  });

  test("resolves once and decides by address, policy and scheme", async () => {
    const resolveTo = (address: string,family = 4) => (async () => [{ address,family }]) as any;
    expect(await resolveCallbackTarget("https://ci.example.com/x",{ allowPrivate: false,resolve: resolveTo("93.184.216.34") }))
      .toEqual({ ok: true,address: "93.184.216.34",family: 4 });
    expect(await resolveCallbackTarget("http://ci.example.com/x",{ allowPrivate: true,resolve: resolveTo("93.184.216.34") }))
      .toEqual({ ok: false,error: "callback_requires_https" });
    expect(await resolveCallbackTarget("http://ci.internal/x",{ allowPrivate: true,resolve: resolveTo("10.0.0.5") }))
      .toMatchObject({ ok: true,address: "10.0.0.5" });
    expect(await resolveCallbackTarget("https://ci.internal/x",{ allowPrivate: false,resolve: resolveTo("10.0.0.5") }))
      .toEqual({ ok: false,error: "callback_host_private" });
    // A name that also points at the server itself is refused outright, policy or not.
    const mixed = (async () => [{ address: "93.184.216.34",family: 4 },{ address: "127.0.0.1",family: 4 }]) as any;
    expect(await resolveCallbackTarget("https://rebind.example/x",{ allowPrivate: true,resolve: mixed }))
      .toEqual({ ok: false,error: "callback_host_blocked" });
    const failing = (async () => { throw new Error("ENOTFOUND"); }) as any;
    expect(await resolveCallbackTarget("https://nowhere.example/x",{ allowPrivate: true,resolve: failing }))
      .toEqual({ ok: false,error: "callback_host_unresolved" });
  });

  test("the signature is HMAC-SHA256 over timestamp and body, keyed with the callback token", () => {
    const expected = createHmac("sha256","token-0123456789abcdef").update('1700000000.{"a":1}').digest("hex");
    expect(callbackSignature("token-0123456789abcdef",'{"a":1}',1_700_000_000)).toBe(`t=1700000000,v1=${expected}`);
    expect(callbackSignature("k".repeat(16),"x",1)).not.toBe(callbackSignature("k".repeat(16),"y",1));
  });

  test("the request goes to the checked address, whatever the host name resolves to", async () => {
    const received: Array<{ host?: string; body: string; signature?: string }> = [];
    const server = createServer((request,response) => {
      let body = "";
      request.on("data",(chunk) => { body += chunk; });
      request.on("end",() => {
        received.push({ host: request.headers.host,body,signature: request.headers["relo-signature"] as string });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0,"127.0.0.1",resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const status = await sendPinnedCallback({
        url: `http://callback.invalid:${port}/relo`,target: { ok: true,address: "127.0.0.1",family: 4 },
        headers: { "relo-signature": "t=1,v1=x","content-type": "application/json" },body: '{"ok":true}',timeoutMs: 2_000,
      });
      expect(status).toBe(204);
      expect(received).toEqual([{ host: `callback.invalid:${port}`,body: '{"ok":true}',signature: "t=1,v1=x" }]);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("private callback policy", () => {
  let db: Database;
  beforeAll(async () => { db = createDatabase(databaseUrl!); await migrate(db); });
  afterAll(async () => {
    await db.query("UPDATE server_settings SET private_callbacks='admin'");
    await db.end();
  });

  test("none, the admin's own account, or every account", async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    await db.query("TRUNCATE auth.users CASCADE");
    const principal = async (handle: string) => (await db.query("INSERT INTO owner_principals(handle) VALUES ($1) RETURNING id",[handle])).rows[0].id;
    const admin = await principal("policy-admin");
    const other = await principal("policy-other");
    for (const [id,isAdmin] of [[admin,true],[other,false]] as const) {
      const subject = `policy-${isAdmin ? "admin" : "other"}`;
      await db.query("INSERT INTO auth.users(id,name,email) VALUES ($1,$1,$2)",[subject,`${subject}@relo.example`]);
      await db.query(`INSERT INTO account_identities(principal_id,provider,subject,server_admin,approved_at)
        VALUES ($1,'better-auth',$2,$3,now())`,[id,subject,isAdmin]);
    }
    await db.query("UPDATE server_settings SET private_callbacks='admin'");
    expect([await allowsPrivateCallbacks(db,admin),await allowsPrivateCallbacks(db,other)]).toEqual([true,false]);
    await db.query("UPDATE server_settings SET private_callbacks='everyone'");
    expect([await allowsPrivateCallbacks(db,admin),await allowsPrivateCallbacks(db,other)]).toEqual([true,true]);
    await db.query("UPDATE server_settings SET private_callbacks='none'");
    expect([await allowsPrivateCallbacks(db,admin),await allowsPrivateCallbacks(db,other)]).toEqual([false,false]);
  });
});
