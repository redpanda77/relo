// `relo services create|list|edit|rotate|revoke`: webhook services for the owner's account. With --secret-file a new
// secret goes to a file the CLI reserved first, never to the output.
import { basename } from "node:path";
import { assertNoExtra, definedFields, requireText } from "../shared/validate.mjs";
import { validateDestinationUrl, validatePublicHttpsUrl } from "../shared/urls.mjs";
import { UsageError } from "../shared/errors.mjs";
import { SCOPES } from "../shared/scopes.generated.mjs";

const SERVICE_SCOPES = new Set(Object.keys(SCOPES).filter((scope) => SCOPES[scope].kinds.includes("service")));

/** --scope and --readable as the server takes them: what a service may do, and whether it may send readable content. */
function servicePolicy(options) {
  const scopes = Array.isArray(options.scope) ? options.scope : options.scope ? [options.scope] : [];
  const unknown = scopes.filter((scope) => !SERVICE_SCOPES.has(scope));
  if (unknown.length) throw new UsageError(`Unknown service scope: ${unknown.join(", ")} (a service holds ${[...SERVICE_SCOPES].join(", ")})`);
  return definedFields({
    scopes: scopes.length ? [...new Set(scopes)] : undefined,
    readableAllowed: options.readable === undefined ? undefined : options.readable === "on",
  });
}
import { releaseSecretFileReservation, reserveSecretFile, writeReservedSecretFile } from "../shared/secret-file.mjs";
import { result } from "../shared/outcome.mjs";
import { stdinObject } from "../shared/stdin.mjs";

async function revokeCreatedService(client, created) {
  const id = created?.service?.id;
  if (typeof id !== "string" || id.length === 0 || typeof client.revokeService !== "function") return false;
  try {
    await client.revokeService(id);
    return true;
  } catch {
    return false;
  }
}

const SERVICE_SECRET = { format: /^hook_[A-Za-z0-9_-]{43}$/u, what: "service secret" };

/** Prints the new secret, or writes it to the reserved --secret-file and prints only the file's name. */
async function deliverSecret(options, issue) {
  const reservation = options["secret-file"] === undefined ? undefined : await reserveSecretFile(options["secret-file"]);
  try {
    const issued = await issue();
    if (!reservation) return issued;
    await writeReservedSecretFile(reservation, issued?.secret, SERVICE_SECRET);
    const { secret: _secret, ...safe } = issued;
    return { ...safe, secretFileWritten: true, secretFileName: basename(options["secret-file"]) };
  } finally {
    if (reservation) await releaseSecretFileReservation(reservation);
  }
}

function serviceId(rest, usage) {
  assertNoExtra(rest, 1, usage);
  const id = rest[0];
  if (typeof id !== "string" || !/^svc_[A-Za-z0-9_-]+$/u.test(id)) throw new UsageError(usage);
  return id;
}

/** `relo services create|list|edit|rotate|revoke`. Returns undefined when the command is not one of them. */
export async function runServicesCommand(command) {
  const { options, group, action, rest, dependencies, client } = command;
  if (group === "services" && action === "create") {
    assertNoExtra(rest, 0, "Usage: relo services create --title TITLE [--secret-file PATH] [options]");
    const stdin = await stdinObject(options, dependencies);
    const releaseReservation = options["secret-file"] === undefined
      ? undefined
      : await reserveSecretFile(options["secret-file"]);
    let created;
    try {
      created = await client.createService(
        definedFields({
          title: requireText(options.title ?? stdin.title, "Service title", 80),
          imageUrl: validatePublicHttpsUrl(options.image ?? stdin.imageUrl, "image"),
          destinationUrl: validateDestinationUrl(
            options.url ?? stdin.destinationUrl ?? stdin.url,
            "url",
          ),
          ...servicePolicy(options),
        }),
      );
      if (options["secret-file"] === undefined) return result("services.create", created);
      try {
        await writeReservedSecretFile(releaseReservation, created?.secret, SERVICE_SECRET);
      } catch (error) {
        await revokeCreatedService(client, created);
        throw error;
      }
      const { secret: _secret, ...safe } = created;
      return result("services.create", {
        ...safe,
        secretFileWritten: true,
        secretFileName: basename(options["secret-file"]),
      });
    } finally {
      if (releaseReservation) await releaseSecretFileReservation(releaseReservation);
    }
  }

  if (group === "services" && action === "rotate") {
    const id = serviceId(rest, "Usage: relo services rotate svc_… [--secret-file PATH]");
    // The old secret stops working at once; a failed file write cannot bring it back, so it is not revoked again.
    return result("services.rotate", await deliverSecret(options, () => client.rotateService(id)));
  }

  if (group === "services" && action === "edit") {
    const id = serviceId(rest, "Usage: relo services edit svc_… [--title T] [--scope S]… [--readable on|off]");
    const body = definedFields({
      title: options.title === undefined ? undefined : requireText(options.title, "Service title", 80),
      ...servicePolicy(options),
    });
    if (!Object.keys(body).length) throw new UsageError("relo services edit needs --title, --scope or --readable");
    return result("services.edit", await client.updateService(id, body));
  }

  if (group === "services" && action === "revoke") {
    const id = serviceId(rest, "Usage: relo services revoke svc_…");
    await client.revokeService(id);
    return result("services.revoke", { id, revoked: true });
  }

  if (group === "services" && action === "list") {
    assertNoExtra(rest, 0, "Usage: relo services list");
    return result("services.list", await client.listServices());
  }
  return undefined;
}
