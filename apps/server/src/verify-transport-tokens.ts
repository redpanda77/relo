import { loadAccountAuthSecret, loadConfig } from "./config.js";
import { createDatabase, type Database } from "./db.js";
import {
  createTransportTokenEncryption,
  verifyCurrentTransportTokenEnvelopes,
  verifyTransportTokenAuthenticity,
} from "./token-encryption.js";

let db: Database | undefined;
try {
  const config = loadConfig();
  db = createDatabase(config.DATABASE_URL);
  const secret = await loadAccountAuthSecret(config);
  const encryption = createTransportTokenEncryption(secret);
  await verifyCurrentTransportTokenEnvelopes(db);
  const tokenCount = await verifyTransportTokenAuthenticity(db,encryption);
  console.log(`Transport token verification passed (${tokenCount} encrypted tokens)`);
} catch {
  console.error("Transport token verification failed");
  process.exitCode = 1;
} finally {
  await db?.end();
}
