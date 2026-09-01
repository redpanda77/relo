import { serve } from "@hono/node-server";
import { createAccountAuth } from "./account-auth.js";
import { createApp } from "./app.js";
import { bootstrapOwner } from "./bootstrap.js";
import { loadAccountAuthSecret, loadConfig, readSecretFile } from "./config.js";
import { createAuthDatabase, createDatabase } from "./db.js";
import { createTransportTokenEncryption, verifyCurrentTransportTokenEnvelopes } from "./token-encryption.js";

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const authDb = createAuthDatabase(config.DATABASE_URL);

const accountAuthSecret = await loadAccountAuthSecret(config);
await verifyCurrentTransportTokenEnvelopes(db);
await bootstrapOwner(db, config.BOOTSTRAP_OWNER_HANDLE, await readSecretFile(config.BOOTSTRAP_OWNER_TOKEN_FILE));
const accountAuth = createAccountAuth(authDb, config.APP_URL, accountAuthSecret);

const server = serve({
  fetch: createApp(db, {
    accountAuth,
    bootstrapOwnerHandle: config.BOOTSTRAP_OWNER_HANDLE,
    credentialDerivationSecret: accountAuthSecret,
    appUrl: config.APP_URL,
    apnsMode: config.APNS_MODE,
  }).fetch,
  hostname: config.HOST,
  port: config.PORT,
});
console.log(`Relo API listening on ${config.HOST}:${config.PORT}`);

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down`);
  server.close();
  await Promise.all([db.end(), authDb.end()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
