/**
 * Registers a login from a digest the operator computed offline (the self-hosting operations notes):
 * the recovery path when no browser sign-in is possible. The server never sees the token.
 *   pnpm --filter @relo/server register-login-hash --handle H --label L --token-hash HEX --scopes a,b
 */
import { parseArgs } from "node:util";
import { z } from "zod";
import { loginScopeSchema } from "@relo/notification-contracts";
import { loadConfig } from "../config.js";
import { createDatabase } from "../db.js";
import { registerLoginDigest } from "./login.js";

const options = parseArgs({
  options: {
    handle: { type: "string" }, label: { type: "string" },
    "token-hash": { type: "string" }, scopes: { type: "string" },
  },
  strict: true,
}).values;

const input = z.object({
  handle: z.string().min(1).max(120),
  label: z.string().min(1).max(120),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  scopes: z.array(loginScopeSchema).min(1),
}).parse({
  handle: options.handle,
  label: options.label,
  tokenHash: options["token-hash"]?.toLowerCase(),
  scopes: options.scopes?.split(",").map((scope) => scope.trim()).filter(Boolean),
});

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
try {
  const credentialId = await registerLoginDigest(db,input);
  if (!credentialId) throw new Error(`Active owner not found: ${input.handle}`);
  console.log(JSON.stringify({ credentialId, label: input.label, scopes: input.scopes }));
} finally {
  await db.end();
}
