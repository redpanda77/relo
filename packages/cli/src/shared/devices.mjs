// The account's phones as the server lists them, and `--device` values resolved against that list.
import { validateDeviceId } from "./validate.mjs";
import { ApiError, UsageError } from "./errors.mjs";

const DEFAULT_DEVICE_PAGE_SIZE = 100;

const MAX_DEVICE_PAGES = 100;

function invalidDevicePage() {
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

/** `verify: false` (a dry run) checks the IDs' shape only, with no request. */
export async function resolveTargetDevices(client, values, { verify = true } = {}) {
  if (values.length === 0) return undefined;
  if (values.length > 50) throw new UsageError("--device may be specified at most 50 times");
  const malformed = values.filter((value) => !validateDeviceId(value));
  if (malformed.length > 0) {
    throw new UsageError(`Malformed target device ID(s): ${malformed.join(", ")}`);
  }
  const deviceIds = [...new Set(values)];
  if (!verify) return deviceIds;
  const response = await listAllDevices(client);
  const known = new Set(response.devices.map((device) => device.deviceId));
  const unknown = deviceIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown target device ID(s): ${unknown.join(", ")}`);
  }
  return deviceIds;
}
