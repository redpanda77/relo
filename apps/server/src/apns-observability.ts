import type { ApnsRuntimeResult } from "./apns-runtime.js";

export type ApnsWorkerCycle = {
  safelyRequeued: number;
  reconciliationRequired: number;
  expiredActivities: number;
  expiredInteractions: number;
  canceledUndeliverable: number;
  claimed: number;
  queueToFirstClaimMaxMs: number;
  acceptedByApns: number;
  retryScheduled: number;
  tokenInvalid: number;
  recipientUnavailable: number;
  rejected: number;
  reconciliationFenced: number;
  ownershipLost: number;
  preparationFailed: number;
  serializationMismatches: number;
  serializationFailures: number;
};

export function emptyApnsWorkerCycle(): ApnsWorkerCycle {
  return {
    safelyRequeued: 0,reconciliationRequired: 0,expiredActivities: 0,expiredInteractions: 0,
    canceledUndeliverable: 0,claimed: 0,queueToFirstClaimMaxMs: 0,
    acceptedByApns: 0,retryScheduled: 0,
    tokenInvalid: 0,recipientUnavailable: 0,rejected: 0,reconciliationFenced: 0,
    ownershipLost: 0,preparationFailed: 0,serializationMismatches: 0,serializationFailures: 0,
  };
}

export function observeApnsRuntimeResult(
  cycle: ApnsWorkerCycle,
  result: ApnsRuntimeResult,
): void {
  if (result.kind === "accepted") cycle.acceptedByApns += 1;
  else if (result.kind === "retry" || result.kind === "retry_scheduled") cycle.retryScheduled += 1;
  else if (result.kind === "invalid_token") cycle.tokenInvalid += 1;
  else if (result.kind === "unavailable") cycle.recipientUnavailable += 1;
  else if (result.kind === "reconcile") cycle.reconciliationFenced += 1;
  else cycle.rejected += 1;
}

export function safeDiagnosticCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 80) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ? value : null;
}

export function apnsOperationalLog(
  event: "apns_worker_started" | "apns_worker_cycle" | "apns_worker_stopped",
  fields: Record<string,string | number | boolean | null>,
): string {
  return JSON.stringify({ event,...fields });
}
