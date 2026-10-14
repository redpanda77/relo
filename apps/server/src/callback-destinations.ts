import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";

/**
 * Where an answer callback may go. Relo sits on a private network (ADR 0003), so a callback may
 * reach a private address when the admin allows it for the asking account; the server's own
 * loopback, link-local and cloud metadata addresses are never reachable.
 */
export type AddressClass = "blocked" | "private" | "public";
export const PRIVATE_CALLBACK_POLICIES = ["none","admin","everyone"] as const;
export type PrivateCallbackPolicy = typeof PRIVATE_CALLBACK_POLICIES[number];

function ipv4Class(address: string): AddressClass {
  const [a = 0,b = 0,c = 0] = address.split(".").map(Number);
  if (a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224) return "blocked";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)) return "private";
  // Documentation and benchmark ranges never route anywhere real.
  if ((a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return "blocked";
  return "public";
}

export function classifyAddress(address: string): AddressClass {
  const version = isIP(address);
  if (version === 4) return ipv4Class(address);
  if (version !== 6) return "blocked";
  const value = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(value);
  if (mapped) return ipv4Class(mapped[1]!);
  if (value === "::" || value === "::1" || /^fe[89ab]/u.test(value) || value.startsWith("ff")) return "blocked";
  if (/^f[cd]/u.test(value)) return "private";
  if (value.startsWith("2001:db8") || value.startsWith("64:ff9b")) return "blocked";
  return "public";
}

/** A callback URL: https anywhere, or http to a private address; no credentials or fragment. */
export const callbackUrlSchema = z.url().max(2_048).superRefine((value,context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    context.addIssue({ code: "custom",message: "A callback URL uses https:// (or http:// on a private network)" });
  }
  if (url.username || url.password) context.addIssue({ code: "custom",message: "A callback URL carries no credentials" });
  if (url.hash) context.addIssue({ code: "custom",message: "A callback URL has no #fragment" });
  const host = url.hostname.replace(/^\[|\]$/gu,"");
  if (isIP(host) && classifyAddress(host) === "blocked") {
    context.addIssue({ code: "custom",message: "A callback cannot target loopback, link-local or metadata addresses" });
  }
  if (host === "localhost" || host.endsWith(".localhost")) {
    context.addIssue({ code: "custom",message: "A callback cannot target the server's own localhost" });
  }
});

export type CallbackTarget =
  | { ok: true; address: string; family: 4 | 6 }
  | { ok: false; error: "callback_host_blocked" | "callback_host_private" | "callback_requires_https" | "callback_host_unresolved" };

/** Resolves once and decides; the request then connects to exactly this address (no rebinding). */
export async function resolveCallbackTarget(value: string,options: {
  allowPrivate: boolean; resolve?: typeof lookup | undefined;
}): Promise<CallbackTarget> {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/gu,"");
  let addresses: { address: string; family: number }[];
  if (isIP(host)) addresses = [{ address: host,family: isIP(host) }];
  else {
    try { addresses = await (options.resolve ?? lookup)(host,{ all: true,verbatim: true }); }
    catch { return { ok: false,error: "callback_host_unresolved" }; }
  }
  if (!addresses.length) return { ok: false,error: "callback_host_unresolved" };
  const classes = addresses.map(({ address }) => classifyAddress(address));
  if (classes.includes("blocked")) return { ok: false,error: "callback_host_blocked" };
  const isPrivate = classes.includes("private");
  if (isPrivate && !options.allowPrivate) return { ok: false,error: "callback_host_private" };
  if (!isPrivate && url.protocol !== "https:") return { ok: false,error: "callback_requires_https" };
  const chosen = addresses[0]!;
  return { ok: true,address: chosen.address,family: chosen.family === 6 ? 6 : 4 };
}

/**
 * Signs like Stripe and GitHub: `Relo-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of
 * "<t>.<body>" keyed with the callback token>`. A receiver recomputes it and rejects stale times.
 */
export function callbackSignature(token: string,body: string,timestamp: number): string {
  const digest = createHmac("sha256",token).update(`${timestamp}.${body}`,"utf8").digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

/**
 * Standard Webhooks signature: `v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">`. A `whsec_`
 * secret is keyed with its base64-decoded bytes; any other token with its UTF-8 bytes.
 */
export function standardWebhookSignature(secret: string,id: string,timestamp: number,body: string): string {
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice(6),"base64") : Buffer.from(secret,"utf8");
  return `v1,${createHmac("sha256",key).update(`${id}.${timestamp}.${body}`,"utf8").digest("base64")}`;
}

export type CallbackSend = (input: {
  url: string; target: Extract<CallbackTarget,{ ok: true }>; headers: Record<string,string>; body: string; timeoutMs: number;
}) => Promise<number>;

/** POSTs to the resolved address while TLS still verifies the URL's host name. Never follows redirects. */
export const sendPinnedCallback: CallbackSend = ({ url,target,headers,body,timeoutMs }) => new Promise((resolve,reject) => {
  const parsed = new URL(url);
  const request = (parsed.protocol === "https:" ? httpsRequest : httpRequest)(parsed,{
    method: "POST",
    headers: { ...headers,"content-length": String(Buffer.byteLength(body)) },
    timeout: timeoutMs,
    // Node asks for every address when it races IPv4 and IPv6; either way it gets only the checked one.
    lookup: ((_hostname: string,options: { all?: boolean },callback: (...args: unknown[]) => void) => options?.all
      ? callback(null,[{ address: target.address,family: target.family }])
      : callback(null,target.address,target.family)) as never,
  },(response) => {
    response.resume();
    resolve(response.statusCode ?? 0);
  });
  request.on("timeout",() => request.destroy(Object.assign(new Error("timeout"),{ name: "TimeoutError" })));
  request.on("error",reject);
  request.end(body);
});

/** Whether an account's callbacks may reach private addresses under the admin's policy. */
export async function allowsPrivateCallbacks(db: { query: (text: string,values?: unknown[]) => Promise<{ rows: any[] }> },
  principalId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT s.private_callbacks AS policy,
       EXISTS (SELECT 1 FROM account_identities i WHERE i.principal_id=$1 AND i.server_admin) AS is_admin,
       NOT EXISTS (SELECT 1 FROM account_identities i WHERE i.server_admin) AS unclaimed
     FROM server_settings s WHERE s.singleton`,[principalId]);
  const row = result.rows[0];
  if (!row || row.policy === "none") return false;
  // Until someone claims the server, its only account is the bootstrapped owner's.
  return row.policy === "everyone" || row.is_admin || row.unclaimed;
}

export async function privateCallbackPolicy(db: { query: (text: string,values?: unknown[]) => Promise<{ rows: any[] }> }): Promise<PrivateCallbackPolicy> {
  return ((await db.query("SELECT private_callbacks FROM server_settings WHERE singleton")).rows[0]?.private_callbacks ?? "admin") as PrivateCallbackPolicy;
}
