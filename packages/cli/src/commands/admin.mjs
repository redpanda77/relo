import { lstat, open } from "node:fs/promises";
import { basename } from "node:path";
import { numberOption, requireText, validateDestinationUrl, validatePublicHttpsUrl } from "../args.mjs";
import { ApiError, UsageError } from "../errors.mjs";
import { assertAllowedOptions, assertNoExtra, definedFields, enumOption, result, stdinObject, validateDeviceId } from "../support.mjs";

export const DEFAULT_DEVICE_PAGE_SIZE = 100;

export const MAX_DEVICE_PAGES = 100;

export function invalidDevicePage() {
  return new ApiError("Device list response was invalid.", { code: "INVALID_API_RESPONSE" });
}

export async function listAllDevices(client, pageSize = DEFAULT_DEVICE_PAGE_SIZE) {
  const devices = [];
  const deviceIds = new Set();
  const cursors = new Set();
  let cursor;

  for (let page = 0; page < MAX_DEVICE_PAGES; page += 1) {
    const response = await client.listDevices({
      limit: pageSize,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!response || typeof response !== "object" || Array.isArray(response)
      || !Array.isArray(response.devices)
      || response.devices.length > pageSize
      || response.devices.some((device) => !device || typeof device !== "object"
        || Array.isArray(device) || !validateDeviceId(device.deviceId))) {
      throw invalidDevicePage();
    }

    const hasCursor = Object.hasOwn(response, "cursor");
    const hasHasMore = Object.hasOwn(response, "hasMore");
    if (!hasCursor || !hasHasMore
      || typeof response.hasMore !== "boolean"
      || (response.hasMore
        ? typeof response.cursor !== "string" || response.cursor.length === 0
        : response.cursor !== null)
      || (response.hasMore && response.devices.length === 0)) {
      throw invalidDevicePage();
    }

    for (const device of response.devices) {
      if (deviceIds.has(device.deviceId)) throw invalidDevicePage();
      deviceIds.add(device.deviceId);
      devices.push(device);
    }
    if (!response.hasMore) return { devices };
    if (cursors.has(response.cursor)) throw invalidDevicePage();
    cursors.add(response.cursor);
    cursor = response.cursor;
  }
  throw invalidDevicePage();
}

export async function resolveTargetDevices(client, values) {
  if (values.length === 0) return undefined;
  if (values.length > 50) throw new UsageError("--device may be specified at most 50 times");
  const malformed = values.filter((value) => !validateDeviceId(value));
  if (malformed.length > 0) {
    throw new UsageError(`Malformed target device ID(s): ${malformed.join(", ")}`);
  }
  const deviceIds = [...new Set(values)];
  const response = await listAllDevices(client);
  const known = new Set(response.devices.map((device) => device.deviceId));
  const unknown = deviceIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown target device ID(s): ${unknown.join(", ")}`);
  }
  return deviceIds;
}

export async function assertSecretFileAvailable(path) {
  if (typeof path !== "string" || path.length === 0) {
    throw new UsageError("--secret-file requires a path");
  }
  try {
    const existing = await lstat(path);
    const kind = existing.isSymbolicLink() ? "symlink" : existing.isFile() ? "file" : "non-regular path";
    throw new UsageError(`Refusing to overwrite an existing ${kind} with --secret-file`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function reserveSecretFile(path) {
  await assertSecretFileAvailable(path);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    if (process.platform !== "win32") await handle.chmod(0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") {
      throw new UsageError("Refusing a --secret-file path that appeared during reservation");
    }
    throw error;
  }
  const info = await handle.stat();
  return {
    path,
    handle,
    identity: { dev: info.dev, ino: info.ino },
  };
}

export function sameFile(info, identity) {
  return info.dev === identity.dev && info.ino === identity.ino;
}

export async function assertReservationPathIdentity(reservation, message) {
  try {
    const current = await lstat(reservation.path);
    if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, reservation.identity)) {
      throw new UsageError(message);
    }
  } catch (error) {
    if (error?.code === "ENOENT") throw new UsageError(message);
    throw error;
  }
}

export async function releaseSecretFileReservation(reservation) {
  await reservation.handle?.close().catch(() => {});
}

export async function writeReservedSecretFile(reservation, webhookUrl) {
  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new ApiError("Service creation response did not include a valid webhook URL.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ApiError("Service creation response did not include a valid webhook URL.", {
      code: "INVALID_API_RESPONSE",
    });
  }

  const contents = Buffer.from(parsed.toString(), "utf8");
  if (contents.length === 0 || contents.length > 4_096) {
    throw new ApiError("Service creation response did not include a valid webhook URL.", {
      code: "INVALID_API_RESPONSE",
    });
  }
  let wrote = false;
  try {
    const current = await reservation.handle.stat();
    if (
      !current.isFile() || current.isSymbolicLink()
      || !sameFile(current, reservation.identity) || current.nlink !== 1 || current.size !== 0
    ) {
      throw new UsageError("Refusing to write a changed --secret-file reservation");
    }
    await assertReservationPathIdentity(
      reservation,
      "Refusing to write a changed --secret-file reservation",
    );
    const result = await reservation.handle.write(contents, 0, contents.length, 0);
    wrote = true;
    if (result.bytesWritten !== contents.length) {
      throw new ApiError("The service secret file write was incomplete.", {
        code: "SECRET_FILE_WRITE_FAILED",
      });
    }
    await reservation.handle.sync();
    await assertReservationPathIdentity(
      reservation,
      "Refusing a changed --secret-file after writing",
    );
    const finalReservation = await reservation.handle.stat();
    if (
      !finalReservation.isFile() || finalReservation.isSymbolicLink()
      || !sameFile(finalReservation, reservation.identity)
      || finalReservation.nlink !== 1 || finalReservation.size !== contents.length
    ) {
      throw new UsageError("Refusing a changed --secret-file after writing");
    }
  } catch (error) {
    if (wrote) {
      await reservation.handle.truncate(0).catch(() => {});
      await reservation.handle.sync().catch(() => {});
    }
    throw error;
  }
}

export async function revokeCreatedService(client, created) {
  const id = created?.service?.id;
  if (typeof id !== "string" || id.length === 0 || typeof client.revokeService !== "function") return false;
  try {
    await client.revokeService(id);
    return true;
  } catch {
    return false;
  }
}

/** Runs this group's commands; returns undefined when the command is not one of them. */
export async function runAdminCommand(command) {
  const { options, group, action, rest, dependencies, client } = command;
  if (group === "delivery" && action === "reconcile") {
    assertNoExtra(rest, 2, "Usage: relo delivery reconcile JOB_ID mark-accepted|retry|cancel");
    assertAllowedOptions(options, []);
    const deliveryId = requireText(rest[0], "Delivery job ID", 80);
    if (!/^job_[A-Za-z0-9-]{12,64}$/u.test(deliveryId)) {
      throw new UsageError("Delivery job ID must use the public job_ identifier.");
    }
    const reconciliationAction = enumOption(
      requireText(rest[1], "Reconciliation action", 32),
      "reconciliation action",
      ["mark-accepted", "retry", "cancel"],
    ).replace("-", "_");
    return result(
      "delivery.reconcile",
      await client.reconcileDelivery(deliveryId, reconciliationAction),
    );
  }

  if (group === "evidence" && action === "timeline") {
    assertNoExtra(rest, 0, "Usage: relo evidence timeline [--notification ID] [--limit 1..100] [--cursor CURSOR]");
    assertAllowedOptions(options, ["notification", "limit", "cursor"]);
    const notificationId = options.notification === undefined
      ? undefined
      : requireText(options.notification, "Notification ID", 80);
    if (notificationId !== undefined && !/^ntf_[A-Za-z0-9-]{12,64}$/u.test(notificationId)) {
      throw new UsageError("Notification ID must use the public ntf_ identifier.");
    }
    const limit = numberOption(options.limit, "limit", {
      minimum: 1,maximum: 100,integer: true,
    });
    const cursor = options.cursor === undefined
      ? undefined
      : requireText(options.cursor, "Evidence cursor", 2_000);
    return result(
      "evidence.timeline",
      await client.getEvidenceTimeline({ notificationId,limit,cursor }),
    );
  }

  if (group === "evidence" && action === "metrics") {
    assertNoExtra(rest, 0, "Usage: relo evidence metrics");
    assertAllowedOptions(options, []);
    return result("evidence.metrics",await client.getEvidenceMetrics());
  }

  if (group === "devices" && action === "list") {
    assertNoExtra(rest, 0, "Usage: relo devices list [--page-size 1..100]");
    assertAllowedOptions(options, ["page-size"]);
    const pageSize = numberOption(options["page-size"], "page-size", {
      minimum: 1,
      maximum: 100,
      integer: true,
    });
    return result("devices.list", await listAllDevices(client, pageSize));
  }

  if (group === "services" && action === "create") {
    assertNoExtra(rest, 0, "Usage: relo services create --title TITLE [--secret-file PATH] [options]");
    assertAllowedOptions(options, ["title", "image", "url", "stdin", "secret-file"]);
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
        }),
      );
      if (options["secret-file"] === undefined) return result("services.create", created);
      try {
        await writeReservedSecretFile(releaseReservation, created?.webhookUrl);
      } catch (error) {
        await revokeCreatedService(client, created);
        throw error;
      }
      const { webhookUrl: _secret, ...safe } = created;
      return result("services.create", {
        ...safe,
        secretFileWritten: true,
        secretFileName: basename(options["secret-file"]),
      });
    } finally {
      if (releaseReservation) await releaseSecretFileReservation(releaseReservation);
    }
  }

  if (group === "services" && action === "list") {
    assertNoExtra(rest, 0, "Usage: relo services list");
    assertAllowedOptions(options, []);
    return result("services.list", await client.listServices());
  }
  return undefined;
}
