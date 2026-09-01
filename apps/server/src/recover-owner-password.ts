import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { recoverOwnerPassword } from "./account-recovery.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";

const options = parseArgs({
  options: {
    handle: { type: "string" },
    "password-file": { type: "string" },
  },
  strict: true,
}).values;

const input = z.object({
  handle: z.string().trim().min(1).max(120),
  passwordFile: z.string().min(1),
}).parse({ handle: options.handle, passwordFile: options["password-file"] });

const metadata = await stat(input.passwordFile);
if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
  throw new Error("Recovery password file must be a regular owner-only file");
}
const password = (await readFile(input.passwordFile,"utf8")).replace(/[\r\n]+$/,"");
z.string().min(8).max(128).parse(password);
const db = createDatabase(loadConfig().DATABASE_URL);
try {
  const result = await recoverOwnerPassword(db,input.handle,password);
  console.log(JSON.stringify({ recovered: true, ...result }));
} finally {
  await db.end();
}
