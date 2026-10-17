// `relo auth token create|list|revoke|rotate`: CI tokens, logins the owner makes for a pipeline or container without a
// browser sign-in (plan 10 A1). The token is shown once, or written to --secret-file; it holds at most this
// login's scopes and always expires.
import { basename } from "node:path";
import { UsageError } from "../shared/errors.mjs";
import { FACTS } from "../shared/facts.mjs";
import { getAuthenticated } from "../shared/login.mjs";
import { result } from "../shared/outcome.mjs";
import { LOGIN_SCOPES } from "../shared/scopes.generated.mjs";
import { releaseSecretFileReservation, reserveSecretFile, writeReservedSecretFile } from "../shared/secret-file.mjs";
import { assertNoExtra, definedFields, parseDuration, requireText } from "../shared/validate.mjs";

const TOKEN = { format: /^relo_[A-Za-z0-9_-]{43}$/u, what: "CI token" };
const USAGE = "Usage: relo auth token create --client-name NAME [--scope S]… [--expires-in 30d] [--secret-file PATH] | list | revoke key_… | rotate key_… [--secret-file PATH]";

function scopes(options) {
  const given = Array.isArray(options.scope) ? options.scope : options.scope ? [options.scope] : [];
  const unknown = given.filter((scope) => !LOGIN_SCOPES.includes(scope));
  if (unknown.length) throw new UsageError(`Unknown scope: ${unknown.join(", ")} (a CI token holds ${LOGIN_SCOPES.join(", ")})`);
  return given.length ? [...new Set(given)] : undefined;
}

/** A new secret for the same CI token; the old one stops at once. If the secret file cannot be written, the new token is lost: rotate again. */
async function rotate(client, options, more, dependencies) {
  assertNoExtra(more, 1, USAGE);
  if (!/^key_[A-Za-z0-9_-]+$/u.test(more[0] ?? "")) throw new UsageError(USAGE);
  const reservation = options["secret-file"] === undefined ? undefined : await reserveSecretFile(options["secret-file"]);
  try {
    const made = await client.request("POST", `/api/credentials/${encodeURIComponent(more[0])}/rotate`, { body: {}, idempotencyKey: dependencies.generateIdempotencyKey?.() });
    if (!reservation) return result("auth.token.rotate", made);
    await writeReservedSecretFile(reservation, made?.token, TOKEN);
    const { token: _token, ...safe } = made;
    return result("auth.token.rotate", { ...safe, secretFileWritten: true, secretFileName: basename(options["secret-file"]) });
  } finally {
    if (reservation) await releaseSecretFileReservation(reservation);
  }
}

export async function runTokenCommand({ options, rest, dependencies }) {
  const [verb, ...more] = rest;
  const { client } = await getAuthenticated(dependencies);
  if (verb === "list") {
    assertNoExtra(more, 0, USAGE);
    return result("auth.token.list", await client.request("GET", "/api/credentials"));
  }
  if (verb === "revoke") {
    assertNoExtra(more, 1, USAGE);
    if (!/^key_[A-Za-z0-9_-]+$/u.test(more[0] ?? "")) throw new UsageError(USAGE);
    await client.request("DELETE", `/api/credentials/${encodeURIComponent(more[0])}`);
    return result("auth.token.revoke", { id: more[0], revoked: true });
  }
  if (verb === "rotate") return rotate(client, options, more, dependencies);
  if (verb !== "create") throw new UsageError(USAGE);
  assertNoExtra(more, 0, USAGE);
  const maximum = FACTS.credentials.ciTokenMaxDays * 86_400;
  const seconds = parseDuration(options["expires-in"], { defaultSeconds: FACTS.credentials.ciTokenDefaultDays * 86_400, minimumSeconds: 86_400, maximumSeconds: maximum });
  const body = definedFields({
    name: requireText(options["client-name"], "--client-name", 80),
    scopes: scopes(options),
    expiresInDays: Math.ceil(seconds / 86_400),
  });
  const reservation = options["secret-file"] === undefined ? undefined : await reserveSecretFile(options["secret-file"]);
  try {
    const made = await client.request("POST", "/api/credentials", { body, idempotencyKey: dependencies.generateIdempotencyKey?.() });
    if (!reservation) return result("auth.token.create", made);
    try {
      await writeReservedSecretFile(reservation, made?.token, TOKEN);
    } catch (error) {
      if (made?.credential?.id) await client.request("DELETE", `/api/credentials/${encodeURIComponent(made.credential.id)}`).catch(() => {});
      throw error;
    }
    const { token: _token, ...safe } = made;
    return result("auth.token.create", { ...safe, secretFileWritten: true, secretFileName: basename(options["secret-file"]) });
  } finally {
    if (reservation) await releaseSecretFileReservation(reservation);
  }
}
