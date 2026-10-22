import { execFileSync } from "node:child_process";
import { createECDH,createHash,randomBytes } from "node:crypto";
import { LOGIN_SCOPES,computerInviteStatusSchema } from "@relo/notification-contracts";
import { mkdirSync,mkdtempSync,renameSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test,vi } from "vitest";
import { createAccountAuth } from "./account-auth.js";
import { createApp } from "./app.js";
import { resetAuthAttempts } from "./auth-throttle.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { bundledCli,bundledMacApp,installScript,macAppcast } from "./computer-invites.js";
import { createAuthDatabase,createDatabase,type Database } from "./db.js";
import { listClientKeys } from "./device-keys.js";
import { migrate } from "./migrate.js";
import { setupProgress } from "./web/setup-progress.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const appUrl = "http://127.0.0.1:8180";
const secret = "test-only-computer-invites-secret-0123456789abcdef";

test("the install script is POSIX sh, pins the CLI digest and joins with the code", () => {
  const script = installScript("https://relo.example",{ version: "0.17.30",sha256: "a".repeat(64),file: "/nowhere" });
  const file = join(mkdtempSync(join(tmpdir(),"relo-install-")),"install.sh");
  writeFileSync(file,script);
  execFileSync("sh",["-n",file]);
  expect(script).toContain("CLI_SHA256='" + "a".repeat(64) + "'");
  expect(script).toContain("\"$BIN/relo\" auth join \"$CODE\" --api-url \"$ORIGIN\"");
  expect(script).toContain("# relo launcher: $ENTRY");
  expect(script).not.toMatch(/sudo/);
  expect(script.indexOf('rm -f "$BIN/relo"')).toBeLessThan(script.indexOf('cat > "$BIN/relo"'));
  expect(script).toContain('rm -f "$BIN/relo"');
  // A cut-off download never runs half the script, and a new account (no startup file) still gets ~/.local/bin on PATH.
  expect(script.trimEnd().endsWith('main "$@"')).toBe(true);
  expect(script).toContain('[ -f "$RC" ] || continue');
  expect(script).toContain('*/zsh) RC="$HOME_DIR/.zshrc"');
});

test("the server hands out Relo for Mac only with both its manifest and its zip", () => {
  const dir = mkdtempSync(join(tmpdir(),"relo-mac-"));
  const url = new URL(`file://${dir}/`);
  expect(bundledMacApp(url)).toBeNull();
  writeFileSync(join(dir,"manifest.json"),JSON.stringify({ version: "0.1.0+1",sha256: "c".repeat(64),app: "Relo Notch.app",executable: "Relo Notch" }));
  expect(bundledMacApp(url)).toBeNull();
  writeFileSync(join(dir,"relo-mac.zip"),"zip");
  expect(bundledMacApp(url)).toMatchObject({ version: "0.1.0+1",app: "Relo Notch.app",executable: "Relo Notch" });
  // No EdDSA signature: no update feed.
  expect(macAppcast("https://relo.example",bundledMacApp(url))).toBeNull();
});

describe("RELO_ARTIFACTS_DIR", () => {
  const cliManifest = (version: string) => JSON.stringify({ version,sha256: "d".repeat(64) });
  const macManifest = (version: string) => JSON.stringify({ version,sha256: "e".repeat(64),app: "Relo Notch.app",executable: "Relo Notch" });
  const publish = (dir: string,kind: "cli" | "mac",manifest: string) => {
    mkdirSync(join(dir,kind),{ recursive: true });
    writeFileSync(join(dir,kind,kind === "cli" ? "relo-cli.tgz" : "relo-mac.zip"),"x");
    writeFileSync(join(dir,kind,"manifest.json"),manifest);
  };
  const image = (kind: "cli" | "mac",manifest: string) => {
    const dir = mkdtempSync(join(tmpdir(),"relo-image-"));
    publish(dir,kind,manifest);
    return new URL(`file://${dir}/${kind}/`);
  };
  const withEnv = (dir: string | undefined,body: () => void) => {
    const before = process.env.RELO_ARTIFACTS_DIR;
    if (dir === undefined) delete process.env.RELO_ARTIFACTS_DIR; else process.env.RELO_ARTIFACTS_DIR = dir;
    try { body(); } finally { if (before === undefined) delete process.env.RELO_ARTIFACTS_DIR; else process.env.RELO_ARTIFACTS_DIR = before; }
  };

  test("the folder wins over the image when it holds a valid manifest, else the image's is served", () => {
    const dir = mkdtempSync(join(tmpdir(),"relo-artifacts-"));
    const bundled = image("cli",cliManifest("1.0.0"));
    const bundledMac = image("mac",macManifest("1.0.0"));
    withEnv(dir,() => {
      publish(dir,"cli",cliManifest("2.0.0"));
      expect(bundledCli()).toMatchObject({ version: "2.0.0",file: join(dir,"cli","relo-cli.tgz") });
      publish(dir,"mac",macManifest("2.0.0"));
      expect(bundledMacApp()).toMatchObject({ version: "2.0.0",file: join(dir,"mac","relo-mac.zip") });
    });
    // An explicit directory (the image's) is read as before, whatever the environment says.
    withEnv(dir,() => {
      expect(bundledCli(bundled)?.version).toBe("1.0.0");
      expect(bundledMacApp(bundledMac)?.version).toBe("1.0.0");
    });
  });

  test("an invalid, partial or missing folder is ignored, and a later valid file is picked up", () => {
    const dir = mkdtempSync(join(tmpdir(),"relo-artifacts-"));
    withEnv(dir,() => {
      mkdirSync(join(dir,"cli"));
      writeFileSync(join(dir,"cli","manifest.json"),"{not json");
      expect(bundledCli()).toBeNull();
      writeFileSync(join(dir,"cli","manifest.json"),JSON.stringify({ version: "2.0.0",sha256: "short" }));
      expect(bundledCli()).toBeNull();
      writeFileSync(join(dir,"cli","manifest.json"),cliManifest("2.0.0")); // a manifest without its tarball is no CLI
      expect(bundledCli()).toBeNull();
      writeFileSync(join(dir,"cli","relo-cli.tgz"),"x");
      expect(bundledCli()?.version).toBe("2.0.0");
    });
    withEnv("relative/path",() => expect(bundledCli()).toBeNull());
    withEnv(join(dir,"missing"),() => expect(bundledMacApp()).toBeNull());
  });

  test("a manifest replaced in place (atomic rename) is read on the next call", () => {
    const dir = mkdtempSync(join(tmpdir(),"relo-artifacts-"));
    withEnv(dir,() => {
      publish(dir,"cli",cliManifest("2.0.0"));
      expect(bundledCli()?.version).toBe("2.0.0");
      writeFileSync(join(dir,"cli","manifest.tmp"),cliManifest("2.0.1"));
      renameSync(join(dir,"cli","manifest.tmp"),join(dir,"cli","manifest.json"));
      expect(bundledCli()?.version).toBe("2.0.1");
      publish(dir,"mac",macManifest("3.0.0"));
      writeFileSync(join(dir,"mac","manifest.tmp"),macManifest("3.0.1"));
      renameSync(join(dir,"mac","manifest.tmp"),join(dir,"mac","manifest.json"));
      expect(bundledMacApp()?.version).toBe("3.0.1");
    });
  });
});

test("Relo for Mac's update feed names the signed build the server hands out", () => {
  const dir = mkdtempSync(join(tmpdir(),"relo-mac-"));
  writeFileSync(join(dir,"relo-mac.zip"),"zip");
  const edSignature = "A".repeat(86) + "==";
  writeFileSync(join(dir,"manifest.json"),JSON.stringify({ version: "0.1.1+260",shortVersion: "0.1.1",build: "260",sha256: "c".repeat(64),
    app: "Relo Notch.app",executable: "Relo Notch",edSignature,length: 10287197,minimumSystemVersion: "14.0" }));
  const feed = macAppcast("https://relo.example",bundledMacApp(new URL(`file://${dir}/`)))!;
  expect(feed).toContain("<sparkle:version>260</sparkle:version>");
  expect(feed).toContain("<sparkle:shortVersionString>0.1.1</sparkle:shortVersionString>");
  expect(feed).toContain(`<enclosure url="https://relo.example/mac/relo-mac.zip" length="10287197" type="application/octet-stream" sparkle:edSignature="${edSignature}"/>`);
  expect(feed).toContain("<sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>");
});

test("the install script installs Relo for Mac only on a Mac, when asked and the server has it, and hands it to the join", () => {
  const cli = { version: "0.17.30",sha256: "a".repeat(64),file: "/nowhere" };
  const mac = { version: "0.1.0+255",sha256: "b".repeat(64),app: "Relo Notch.app",executable: "Relo Notch",file: "/nowhere" };
  const script = installScript("https://relo.example",cli,mac);
  const file = join(mkdtempSync(join(tmpdir(),"relo-install-")),"install.sh");
  writeFileSync(file,script);
  execFileSync("sh",["-n",file]);
  expect(script).toContain("MAC_SHA256='" + "b".repeat(64) + "'");
  expect(script).toContain('--mac-app) WANT_MAC=1 ;;');
  expect(script).toContain('[ "$(uname -s)" != Darwin ]');
  expect(script).toContain('fetch "$ORIGIN/mac/relo-mac.zip" "$WORK/relo-mac.zip"');
  expect(script).toContain('--mac-app "$APP"');
  // A server without the app says so instead of failing.
  expect(installScript("https://relo.example",cli)).toContain("MAC_SHA256=''");
});

// Add a computer (docs/site/guides/servers.md): a trusted device makes a one-time code; the new computer redeems it once.
suite("computer invites",() => {
  let db: Database,authDb: Database,app: ReturnType<typeof createApp>,principalId: string,owner: string;

  beforeAll(async () => {
    resetAuthAttempts();
    db = createDatabase(databaseUrl!);
    authDb = createAuthDatabase(databaseUrl!);
    await migrate(db);
    app = createApp(db,{ accountAuth: createAccountAuth(authDb,appUrl,secret),bootstrapOwnerHandle: "owner",
      credentialDerivationSecret: secret,appUrl,apnsMode: "sandbox" });
  });
  afterAll(async () => { await Promise.all([db.end(),authDb.end()]); });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    owner = "computer_invites_owner_abcdefghijklmnopqrstuvwxyz_0123";
    await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });

  async function call(token: string | null,method: string,path: string,body?: unknown) {
    const response = await app.request(path,{ method,headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json","idempotency-key": randomUUID() },body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }

  async function phone() {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment) VALUES ($1,$2,$3,'iPhone','com.example.relo.notifications','1','1','26','sandbox')
      RETURNING id`,[principalId,randomUUID(),randomUUID()])).rows[0]!.id;
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [id,hashToken(credential)]);
    return credential;
  }

  const redeem = (code: string,clientName = "Build box",scopes: readonly string[] = ["notifications:send","interactions:read"]) =>
    call(null,"POST","/api/computer-invites/redeem",{ code,clientName,scopes,expiresInSeconds: 86_400 });
  // What `relo auth join` asks for: every scope a login may hold.
  const joinScopes = LOGIN_SCOPES;
  const internalLoginId = (clientId: string) => clientId.slice("key_".length);

  test("a phone makes a code; the new computer redeems it once for its own login, with the setup the owner chose",async () => {
    const made = await call(await phone(),"POST","/api/devices/self/computer-invites",{ level: "guide",approvals: true,agents: ["claude-code","opencode"] });
    expect(made.status).toBe(201);
    expect(made.body.code).toMatch(/^rci_[A-Za-z0-9_-]{32}$/);
    expect(made.body.command).toBe(`curl -fsSL ${appUrl}/install.sh | sh -s -- ${made.body.code}`);
    const joined = await redeem(made.body.code);
    expect(joined.status).toBe(200);
    expect(joined.body.accessToken).toMatch(/^relo_/);
    expect(joined.body.credential.clientName).toBe("Build box");
    expect(joined.body.setup).toEqual({ level: "guide",approvals: true,agents: ["claude-code","opencode"],macApp: false });
    expect(joined.body.macAppSignInCode).toBeUndefined();
    expect((await call(joined.body.accessToken,"GET","/api/clients/self")).status).toBe(200);
    // Once only.
    expect((await redeem(made.body.code,"Other box")).body.error).toBe("invalid_code");
    expect((await db.query("SELECT count(*)::int AS n FROM computer_invites WHERE principal_id=$1 AND redeemed_at IS NOT NULL",[principalId])).rows[0].n).toBe(1);
  });

  test("a code made with Relo for Mac hands the installer a one-time sign-in code the Mac app exchanges with its verifier",async () => {
    const subject = `computer-invites-owner-${randomUUID()}`;
    await db.query("INSERT INTO auth.users(id,name,email) VALUES ($1,'Owner',$2)",[subject,`${subject}@relo.example`]);
    await db.query(`INSERT INTO account_identities(principal_id,provider,subject,role,approved_at) VALUES ($1,'better-auth',$2,'owner',now())`,
      [principalId,subject]);
    const made = await call(await phone(),"POST","/api/devices/self/computer-invites",{ macApp: true });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ macApp: true });
    expect(made.body.command).toBe(`curl -fsSL ${appUrl}/install.sh | sh -s -- ${made.body.code} --mac-app`);
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const joined = await call(null,"POST","/api/computer-invites/redeem",{ code: made.body.code,clientName: "Mac box",
      scopes: ["notifications:send"],expiresInSeconds: 86_400,macAppChallenge: challenge });
    expect(joined.status).toBe(200);
    expect(joined.body.setup.macApp).toBe(true);
    expect(joined.body.macAppSignInCode).toMatch(/^relo_signin_[A-Za-z0-9_-]{43}$/);
    // Only the verifier opens it, once.
    const exchange = (codeVerifier: string) => call(null,"POST","/api/mobile/sign-in/token",
      { code: joined.body.macAppSignInCode,codeVerifier,installationId: "mac-installation-1" });
    expect((await exchange(randomBytes(32).toString("base64url"))).body.error).toBe("invalid_grant");
    const session = await exchange(verifier);
    expect(session.status).toBe(200);
    expect(session.body.user.email).toBe(`${subject}@relo.example`);
    expect((await exchange(verifier)).body.error).toBe("invalid_grant");
  });

  test("a code made without Relo for Mac never hands out a sign-in code, whatever the redeem asks",async () => {
    const subject = `computer-invites-owner-${randomUUID()}`;
    await db.query("INSERT INTO auth.users(id,name,email) VALUES ($1,'Owner',$2)",[subject,`${subject}@relo.example`]);
    await db.query(`INSERT INTO account_identities(principal_id,provider,subject,role,approved_at) VALUES ($1,'better-auth',$2,'owner',now())`,
      [principalId,subject]);
    const made = await call(owner,"POST","/api/clients/computer-invites",{});
    const joined = await call(null,"POST","/api/computer-invites/redeem",{ code: made.body.code,clientName: "Plain box",
      scopes: ["notifications:send"],expiresInSeconds: 86_400,macAppChallenge: "c".repeat(43) });
    expect(joined.status).toBe(200);
    expect(joined.body.macAppSignInCode).toBeUndefined();
    expect((await db.query("SELECT count(*)::int AS n FROM mobile_sign_in_codes WHERE principal_id=$1",[principalId])).rows[0].n).toBe(0);
  });

  test("a signed-in computer makes one too; an expired, unknown or malformed code signs nothing in; a phone credential cannot redeem a CLI route",async () => {
    const made = await call(owner,"POST","/api/clients/computer-invites",{});
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ level: "track",approvals: false,agents: null });
    expect((await call(owner,"POST","/api/clients/computer-invites",{ agents: ["Not A Harness"] })).status).toBe(400);
    await db.query("UPDATE computer_invites SET expires_at=now()-interval '1 minute'");
    expect((await redeem(made.body.code)).body.error).toBe("invalid_code");
    expect((await redeem(`rci_${"x".repeat(32)}`)).body.error).toBe("invalid_code");
    expect((await redeem("not-a-code")).status).toBe(400);
    expect((await call(await phone(),"POST","/api/clients/computer-invites",{})).status).toBe(403);
    expect((await db.query("SELECT count(*)::int AS n FROM principal_api_keys WHERE label='Build box'")).rows[0].n).toBe(0);
  });

  test("the Set up checklist ticks from real state: a used login, a phone, a covered agent, a first card",async () => {
    const before = await setupProgress(db,principalId);
    expect(before).toMatchObject({ phone: false,agents: false,firstCard: false });
    const joined = await redeem((await call(owner,"POST","/api/clients/computer-invites",{})).body.code);
    expect((await call(joined.body.accessToken,"GET","/api/clients/self")).status).toBe(200);
    await phone();
    await db.query(`INSERT INTO computers(principal_id,login_key_id,report,reported_at) SELECT principal_id,id,$1,now() FROM principal_api_keys
       WHERE label='Build box' ON CONFLICT (login_key_id) DO UPDATE SET report=EXCLUDED.report,reported_at=now()`,
      [{ harnesses: [{ id: "claude-code",detected: true,level: "guide" },{ id: "codex",detected: true,level: "none" },
        { id: "gemini",detected: false,level: "none" }] }]);
    const after = await setupProgress(db,principalId);
    expect(after).toMatchObject({ computer: true,phone: true,agents: true,firstCard: false });
  });

  const report = { cli: { version: "0.17.40",latest: null,update: "current" },os: { platform: "linux",release: "6.8" },machineKind: "server",
    harnesses: [{ id: "claude-code",detected: true,instructions: "set",level: "guide",modules: [],skill: "current",hooks: "presence",
      hooksOutdated: false,mcp: "none" }],settings: [],profiles: { count: 1,active: "default" },
    doctor: { at: "2026-10-17T10:00:00Z",ok: false,failing: ["phone"] },outbox: { pending: 0 } };

  test("the status of a code is derived at every step, for the owner's phone and browser, and no other account sees it",async () => {
    const credential = await phone();
    const made = await call(credential,"POST","/api/devices/self/computer-invites",{});
    expect(made.body.inviteId).toMatch(/^cin_[0-9a-f-]{36}$/);
    const path = `/api/devices/self/computer-invites/${made.body.inviteId}`;
    const status = async () => {
      const read = await call(credential,"GET",path);
      expect(read.status).toBe(200);
      return computerInviteStatusSchema.parse(read.body);
    };
    expect(await status()).toMatchObject({ inviteId: made.body.inviteId,state: "waiting",computer: null });
    expect((await app.request(path,{ headers: { authorization: `Bearer ${credential}` } })).headers.get("cache-control")).toBe("private, no-store");

    const joined = await redeem(made.body.code,"build-box",joinScopes);
    const cli = joined.body.accessToken as string;
    const redeemed = await status();
    expect(redeemed.state).toBe("redeemed");
    expect(redeemed.computer).toMatchObject({ name: "build-box",cliVersion: null,harnesses: [],check: null });
    expect(redeemed.computer!.clientId).toMatch(/^key_/);
    expect(redeemed.computer).toMatchObject({ identityKey: null,binding: null });
    // A phone registered before the computer joined shows it pending until a device approves its key.
    expect(redeemed.computer?.approval).toBe("waiting");

    const key = createECDH("prime256v1");
    const identityKey = key.generateKeys().toString("base64url");
    const binding = randomBytes(32).toString("base64url");
    expect((await call(cli,"PUT","/api/clients/self/keys",{ identityKey,binding })).status).toBe(200);
    expect((await status()).state).toBe("key_published");
    expect((await status()).computer).toMatchObject({ identityKey,binding });
    // The same key published again, with or without a binding, keeps the stored one; the server never checks it.
    expect((await call(cli,"PUT","/api/clients/self/keys",{ identityKey })).status).toBe(200);
    expect((await call(cli,"PUT","/api/clients/self/keys",{ identityKey,binding: randomBytes(32).toString("base64url") })).status).toBe(200);
    expect((await status()).computer?.binding).toBe(binding);
    expect((await call(cli,"PUT","/api/clients/self/keys",{ identityKey,binding: "short" })).status).toBe(400);
    // A different key replaces the binding with its own (or none).
    const other = createECDH("prime256v1").generateKeys().toString("base64url");
    expect((await call(cli,"PUT","/api/clients/self/keys",{ identityKey: other })).status).toBe(200);
    expect((await status()).computer).toMatchObject({ identityKey: other,binding: null });
    const listed = await listClientKeys(db,principalId);
    expect(listed.find((entry) => entry.publicKey === other)?.binding).toBeNull();
    expect((await call(cli,"PUT","/api/clients/self/keys",{ identityKey,binding })).status).toBe(200);
    expect((await status()).computer).toMatchObject({ identityKey,binding });
    expect((await listClientKeys(db,principalId)).find((entry) => entry.publicKey === identityKey)?.binding).toBe(binding);

    expect((await call(cli,"PUT","/api/computers/self/report",report)).status).toBe(204);
    const reported = await status();
    expect(reported.state).toBe("reported");
    expect(reported.computer).toMatchObject({ cliVersion: "0.17.40",check: { ok: false,failing: ["phone"] },
      harnesses: [{ id: "claude-code",detected: true,level: "guide" }] });

    const approver = (await db.query<{ id: string }>("SELECT id FROM devices WHERE principal_id=$1 LIMIT 1",[principalId])).rows[0]!.id;
    await db.query(`INSERT INTO computer_approvals(api_key_id,principal_id,identity_key,approved_by_device,signed_at,signature)
      VALUES ($1,$2,$3,$4,$5,$6)`,[internalLoginId(reported.computer!.clientId),principalId,identityKey,approver,new Date().toISOString(),"A".repeat(86)]);
    expect((await status()).computer?.approval).toBe("approved");

    expect((await call(cli,"POST","/api/notifications",{ sourceName: "Relo",title: "Relo is set up on this computer",body: "Hello" })).status)
      .toBeLessThan(300);
    expect((await status()).state).toBe("tested");

    // Another account's phone gets the same answer as for an id that does not exist.
    const otherId = (await db.query<{ id: string }>("INSERT INTO owner_principals(handle) VALUES ('other') RETURNING id")).rows[0]!.id;
    const otherPhone = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment) VALUES ($1,$2,$3,'iPhone','com.example.relo.notifications','1','1','26','sandbox')
      RETURNING id`,[otherId,randomUUID(),randomUUID()])).rows[0]!.id;
    const otherToken = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [otherPhone,hashToken(otherToken)]);
    expect(await call(otherToken,"GET",path)).toEqual({ status: 404,body: { error: "not_found" } });
    expect(await call(credential,"GET",`/api/devices/self/computer-invites/cin_${randomUUID()}`)).toEqual({ status: 404,body: { error: "not_found" } });
    expect((await call(credential,"GET","/api/devices/self/computer-invites/nope")).status).toBe(404);
  });

  test("an unredeemed code past its time reads expired",async () => {
    const credential = await phone();
    const made = await call(credential,"POST","/api/devices/self/computer-invites",{});
    await db.query("UPDATE computer_invites SET expires_at=now()-interval '1 minute'");
    expect((await call(credential,"GET",`/api/devices/self/computer-invites/${made.body.inviteId}`)).body.state).toBe("expired");
  });

  test("a redemption, a key, a report and a notification each wake the account's live streams",async () => {
    const listener = await db.connect();
    const hints: string[] = [];
    listener.on("notification",(message) => { if (message.channel === "relo_current_changes") hints.push(message.payload ?? ""); });
    try {
      await listener.query("LISTEN relo_current_changes");
      const made = await call(await phone(),"POST","/api/devices/self/computer-invites",{});
      hints.length = 0;
      const cli = (await redeem(made.body.code,"Build box",joinScopes)).body.accessToken as string;
      await vi.waitFor(() => expect(hints.some((hint) => hint.includes(principalId))).toBe(true),{ timeout: 10_000 });
      hints.length = 0;
      await call(cli,"PUT","/api/clients/self/keys",{ identityKey: createECDH("prime256v1").generateKeys().toString("base64url") });
      await vi.waitFor(() => expect(hints.some((hint) => hint.includes(principalId))).toBe(true),{ timeout: 10_000 });
      hints.length = 0;
      await call(cli,"PUT","/api/computers/self/report",report);
      await vi.waitFor(() => expect(hints.some((hint) => hint.includes(principalId))).toBe(true),{ timeout: 10_000 });
    } finally {
      await listener.query("UNLISTEN relo_current_changes");
      listener.release();
    }
  });
});
