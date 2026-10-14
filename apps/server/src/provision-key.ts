import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";

const allowedScopes = [
  "notifications:send", "interactions:create", "interactions:read", "activities:write",
  "activities:read", "devices:read", "services:read", "services:write",
] as const;

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
  scopes: z.array(z.enum(allowedScopes)).min(1),
}).parse({
  handle: options.handle,
  label: options.label,
  tokenHash: options["token-hash"]?.toLowerCase(),
  scopes: options.scopes?.split(",").map((scope) => scope.trim()).filter(Boolean),
});

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
try {
  const result = await db.query<{ id: string }>(
    `INSERT INTO principal_api_keys(principal_id,label,token_hash,scopes)
     SELECT p.id,$2,$3,$4 FROM owner_principals p WHERE p.handle=$1 AND p.disabled_at IS NULL
     ON CONFLICT (principal_id,label) DO UPDATE SET
       token_hash=EXCLUDED.token_hash,scopes=EXCLUDED.scopes,revoked_at=NULL
     RETURNING id`,
    [input.handle,input.label,input.tokenHash,input.scopes],
  );
  if (!result.rowCount) throw new Error(`Active owner not found: ${input.handle}`);
  console.log(JSON.stringify({ credentialId: result.rows[0]!.id, label: input.label, scopes: input.scopes }));
} finally {
  await db.end();
}
