import { createReadStream,statSync } from "node:fs";
import { Readable } from "node:stream";
import type { Context,Hono } from "hono";
import { requireScope } from "../auth.js";
import {
  bundledCli,bundledMacApp,bundledWindowsApp,createInvite,macAppcast,createInviteSchema,installScript,installScriptPowerShell,inviteStatus,
  redeemInvite,redeemInviteSchema,windowsUpdateFeed,
} from "../computer-invites.js";
import { registerInviteActivityToken } from "../computer-invite-activity.js";
import type { Database } from "../db.js";
import { authorizationRateLimitBuckets,limitedAcrossBuckets } from "../device-authorization.js";
import { ownerOverviewSql } from "../owner-overview.js";
import type { ApiRouteContext } from "./route-context.js";

const redeemAttempts = new Map<string, number[]>();

/** A published file streamed from disk with its length, so a download of tens of megabytes is never held in memory (a file gone since it was listed is a 404). */
function streamFile(context: Context,file: string,headers: Record<string,string>): Response {
  try {
    const { size } = statSync(file);
    return context.body(Readable.toWeb(createReadStream(file)) as ReadableStream,200,{ ...headers,"content-length": String(size) });
  } catch {
    return context.json({ error: "not_found" },404);
  }
}

/**
 * Add a computer, the public half (docs/site/guides/servers.md): the install script, the CLI it installs, and the
 * redemption of a one-time code. Registered before bearer authentication; redemption is throttled per client address.
 */
export function registerPublicComputerInviteRoutes(app: Hono, db: Database, appUrl: string): void {
  const origin = new URL(appUrl).origin;
  const cli = () => bundledCli();

  app.get("/install.sh", (context) => {
    const bundled = cli();
    if (!bundled) return context.text("# This Relo server has no CLI to install.\nexit 1\n", 503);
    context.header("cache-control","no-store");
    return context.body(installScript(origin,bundled,bundledMacApp()),200,{ "content-type": "text/x-shellscript; charset=utf-8" });
  });

  // The same for PowerShell: `irm <origin>/install.ps1 | iex`, or with a code (computer-invites.ts, inviteCommand).
  app.get("/install.ps1", (context) => {
    const bundled = cli();
    if (!bundled) return context.text("throw 'This Relo server has no CLI to install.'\n", 503);
    context.header("cache-control","no-store");
    return context.body(installScriptPowerShell(origin,bundled,bundledWindowsApp()),200,{ "content-type": "text/plain; charset=utf-8" });
  });

  app.get("/cli/relo-cli.tgz", (context) => {
    const bundled = cli();
    if (!bundled) return context.json({ error: "not_found" },404);
    return streamFile(context,bundled.file,{ "content-type": "application/gzip",
      "x-relo-cli-version": bundled.version,"x-relo-cli-sha256": bundled.sha256,"cache-control": "no-store" });
  });

  // Relo for Mac, when this server hands it out (the install script's --mac-app).
  app.get("/mac/relo-mac.zip", (context) => {
    const mac = bundledMacApp();
    if (!mac) return context.json({ error: "not_found" },404);
    return streamFile(context,mac.file,{ "content-type": "application/zip",
      "x-relo-mac-version": mac.version,"x-relo-mac-sha256": mac.sha256,"cache-control": "no-store" });
  });

  // The DMG people download from the docs (plan 16): Relo for Mac with its own server, signed.
  app.get("/mac/relo-mac.dmg", (context) => {
    const mac = bundledMacApp();
    if (!mac?.dmg) return context.json({ error: "not_found" },404);
    return streamFile(context,mac.dmg,{ "content-type": "application/x-apple-diskimage",
      "content-disposition": `attachment; filename="Relo.dmg"`,"x-relo-mac-version": mac.version,"cache-control": "no-store" });
  });

  // Relo for Mac's update feed (Sparkle): the build above, signed; 404 when this server has none to offer.
  app.get("/mac/appcast.xml", (context) => {
    const feed = macAppcast(origin,bundledMacApp());
    if (!feed) return context.json({ error: "not_found" },404);
    return context.body(feed,200,{ "content-type": "application/rss+xml; charset=utf-8","cache-control": "no-store" });
  });

  // Relo for Windows, when this server hands it out: the per-user installer (install.ps1 -WindowsApp, and the landing page's download).
  app.get("/windows/relo-setup.exe", (context) => {
    const windows = bundledWindowsApp();
    if (!windows) return context.json({ error: "not_found" },404);
    return streamFile(context,windows.file,{ "content-type": "application/vnd.microsoft.portable-executable",
      "content-disposition": `attachment; filename="Relo-Setup.exe"`,"x-relo-windows-version": windows.version,"x-relo-windows-sha256": windows.sha256,
      "cache-control": "no-store" });
  });

  // The update payload the app downloads (the installer zipped, signed with the updater key).
  app.get("/windows/relo-windows.zip", (context) => {
    const windows = bundledWindowsApp();
    if (!windows?.zip) return context.json({ error: "not_found" },404);
    return streamFile(context,windows.zip,{ "content-type": "application/zip","x-relo-windows-version": windows.version,"cache-control": "no-store" });
  });

  // Relo for Windows' update feed (Tauri updater, static JSON); 404 when this server has none to offer.
  app.get("/windows/update.json", (context) => {
    const feed = windowsUpdateFeed(origin,bundledWindowsApp());
    if (!feed) return context.json({ error: "not_found" },404);
    context.header("cache-control","no-store");
    return context.json(feed);
  });

  // The CLI this server hands out, for `relo update` and doctor's "behind" check (no account needed).
  app.get("/cli/version", (context) => {
    const bundled = cli();
    if (!bundled) return context.json({ error: "not_found" },404);
    context.header("cache-control","no-store");
    return context.json({ version: bundled.version,sha256: bundled.sha256 });
  });

  app.post("/api/computer-invites/redeem", async (context) => {
    if (limitedAcrossBuckets(redeemAttempts,authorizationRateLimitBuckets(context),10,40,60_000)) {
      context.header("Retry-After","60");
      return context.json({ error: "rate_limited" },429);
    }
    const parsed = redeemInviteSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "invalid_code" },400);
    const result = await redeemInvite(db,parsed.data);
    if (!result.ok) {
      return context.json(result.error === "client_name_taken"
        ? { error: result.error,message: "A CI token already has this name; join with another --client-name." }
        : { error: result.error },result.error === "invalid_code" ? 400 : 409);
    }
    return context.json({ accessToken: result.accessToken,credential: result.credential,setup: result.setup,
      // macAppSignInCode: the old name, for CLIs that predate desktopAppSignInCode.
      ...(result.desktopAppSignInCode ? { desktopAppSignInCode: result.desktopAppSignInCode,macAppSignInCode: result.desktopAppSignInCode } : {}) });
  });
}

/** Add a computer from a trusted phone or Mac app, or from a computer already signed in (its own login, not a CI token). */
export function registerComputerInviteRoutes(app: Hono, shared: ApiRouteContext): void {
  const { db } = shared;
  const origin = () => shared.integratedDependencies ? new URL(shared.integratedDependencies.appUrl).origin : null;

  app.post("/api/devices/self/computer-invites", requireScope("device:self"), async (context) => {
    const auth = context.get("auth");
    const at = origin();
    if (!auth.deviceId || !at) return context.json({ error: "device_credential_required" },403);
    const parsed = createInviteSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success) return context.json({ error: "invalid_invite" },400);
    const device = (await db.query<{ name: string; mac: boolean }>(
      `SELECT name,${ownerOverviewSql("d")} AS mac FROM devices d WHERE d.id=$1 AND d.principal_id=$2 AND d.revoked_at IS NULL`,
      [auth.deviceId,auth.principalId])).rows[0];
    if (!device) return context.json({ error: "device_credential_required" },403);
    return context.json(await createInvite(db,auth.principalId,{ kind: device.mac ? "mac" : "phone",name: device.name },parsed.data,at),201);
  });

  app.get("/api/devices/self/computer-invites/:inviteId", requireScope("device:self"), async (context) => {
    const status = await inviteStatus(db,context.get("auth").principalId,context.req.param("inviteId") ?? "");
    context.header("cache-control","private, no-store");
    return status ? context.json(status) : context.json({ error: "not_found" },404);
  });

  // The phone's wizard Live Activity: its ActivityKit push token. Cleared when the activity ends.
  app.put("/api/devices/self/computer-invites/:inviteId/activity", requireScope("device:self"), async (context) => {
    const auth = context.get("auth");
    if (!auth.deviceId) return context.json({ error: "device_credential_required" },403);
    const body = await context.req.json().catch(() => null) as { pushToken?: unknown } | null;
    const pushToken = body && Object.keys(body).length === 1 && typeof body.pushToken === "string" ? body.pushToken : "";
    if (!/^[0-9a-fA-F]{32,400}$/.test(pushToken)) return context.json({ error: "invalid_push_token" },400);
    const stored = await registerInviteActivityToken(db,shared.callbackEncryption(),{
      principalId: auth.principalId,deviceId: auth.deviceId,inviteId: context.req.param("inviteId") ?? "",pushToken });
    return stored ? context.body(null,204) : context.json({ error: "not_found" },404);
  });

  app.post("/api/clients/computer-invites", requireScope("services:write"), async (context) => {
    const auth = context.get("auth");
    const at = origin();
    if (auth.credentialKind !== "principal" || !auth.credentialId || auth.loginKind === "ci-token" || !at) {
      return context.json({ error: "principal_credential_required" },403);
    }
    const parsed = createInviteSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success) return context.json({ error: "invalid_invite" },400);
    const login = (await db.query<{ label: string }>("SELECT label FROM principal_api_keys WHERE id=$1",[auth.credentialId])).rows[0];
    return context.json(await createInvite(db,auth.principalId,{ kind: "computer",name: login?.label ?? "a computer" },parsed.data,at),201);
  });
}
