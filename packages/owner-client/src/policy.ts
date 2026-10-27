import { z } from "zod";
import { OwnerClientError } from "./errors.js";
import { errorCode, failFor, readJson, type OwnerHttp } from "./http.js";

/**
 * The account's end-to-end encryption choice on a remote server (EncryptionPolicy.swift): Automatic seals once an iPhone is
 * trusted, Always seals from the start, Off is the Dashboard's to set.
 */
export type EncryptionMode = "on" | "off" | "auto";
export interface EncryptionPolicy { mode: EncryptionMode; required: boolean }

const policySchema = z.object({ mode: z.enum(["on", "off", "auto"]), required: z.boolean().optional() }).passthrough();

function parsePolicy(value: unknown): EncryptionPolicy {
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) throw new OwnerClientError("invalid_response", 200);
  return { mode: parsed.data.mode, required: parsed.data.required ?? parsed.data.mode === "on" };
}

/** The title the picker shows (EncryptionPolicy.title). */
export function encryptionTitle(mode: EncryptionMode): string {
  return mode === "on" ? "Always" : mode === "off" ? "Off" : "Automatic";
}

/** The detail under the picker (ReloEncryptionGroup.detail). */
export function encryptionDetail(mode: EncryptionMode): string {
  switch (mode) {
    case "auto": return "Automatic: on once an iPhone is trusted";
    case "on": return "Always: every card is sealed for your trusted devices";
    case "off": return "Off: cards are stored readable on the server";
  }
}

export const ENCRYPTION_NO_PHONE_NOTE = "Cards will open only on this PC until you add an iPhone.";

/** Always with no trusted iPhone: the cards are sealed for nobody else, so only this PC reads them. */
export function encryptionNote(policy: EncryptionPolicy | null, phoneTrusted: boolean): string | null {
  return policy?.mode === "on" && !phoneTrusted ? ENCRYPTION_NO_PHONE_NOTE : null;
}

/** GET /api/end-to-end/policy (device-routes.ts): `{ required, mode }`. */
export async function readEncryptionPolicy(http: OwnerHttp, accessToken: string): Promise<EncryptionPolicy> {
  const response = await http.request("/api/end-to-end/policy", { bearer: accessToken });
  if (response.status !== 200) throw failFor(response, await errorCode(response));
  return parsePolicy(await readJson(response));
}

/**
 * PUT /api/end-to-end/policy with `{"required":true}` (Always) or `{"required":null}` (Automatic). Off is never sent: the
 * server answers 403 `turn_off_in_dashboard` to it, and an owner-overview device may only tighten the policy.
 */
export async function writeEncryptionPolicy(http: OwnerHttp, accessToken: string, always: boolean): Promise<EncryptionPolicy> {
  const response = await http.request("/api/end-to-end/policy", { method: "PUT", bearer: accessToken, body: { required: always ? true : null } });
  if (response.status !== 200) throw failFor(response, await errorCode(response));
  return parsePolicy(await readJson(response));
}
