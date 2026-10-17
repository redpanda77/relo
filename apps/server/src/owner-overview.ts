/**
 * Owner overview devices (docs/CHOICE-QUESTIONS.md, "Device capabilities"): an owner surface that is
 * not a phone, such as the Mac's notch app, declares `owner_overview`. Delivery is a delivery concern
 * and stays strict (activity-commands/runtime.ts eligibleDevices): such a device is never a target.
 * Visibility is account-level for owner surfaces: like the Dashboard, an overview device sees the
 * whole account's Now, while per-device sealed envelopes are still chosen by its own device id.
 *
 * This module is the only place that decides which device's delivery targets bound a read. Every
 * phone-scoped read passes `visibilityDeviceId(reader)` where it filters by targets, and the reader's
 * own `deviceId` where it selects that device's envelopes, receipts or delivery jobs.
 */
export const OWNER_OVERVIEW = "owner_overview";

/** Who reads: the authenticated device (if any) and whether it declared `owner_overview`. */
export type DeviceReader = { deviceId?: string | undefined; ownerOverview?: boolean | undefined };

/** Whether a device's declared capabilities make it an owner overview device. */
export function isOwnerOverview(capabilities: readonly string[] | null | undefined): boolean {
  return Array.isArray(capabilities) && capabilities.includes(OWNER_OVERVIEW);
}

/**
 * The device whose delivery targets bound what `reader` sees: a phone's own id. Undefined for the
 * browser and for an overview device, whose reads are account-level.
 */
export function visibilityDeviceId(reader: DeviceReader): string | undefined {
  return reader.ownerOverview ? undefined : reader.deviceId;
}

/** A device that reads the whole account: it lists and answers the copy of a question the asker waits on. */
export function readsAccount(reader: DeviceReader): boolean {
  return reader.deviceId !== undefined && reader.ownerOverview === true;
}

/** SQL for "this device row is an owner overview device" (it never approves or holds back another device). */
export const ownerOverviewSql = (alias: string) => `('${OWNER_OVERVIEW}'=ANY(${alias}.capabilities))`;
