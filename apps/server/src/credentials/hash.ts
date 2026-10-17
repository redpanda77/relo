import { randomBytes } from "node:crypto";
import { sha256Hex } from "../digest.js";
import { CREDENTIAL_KIND_TABLE } from "./kinds.js";

const MACHINE = CREDENTIAL_KIND_TABLE.login.token;
const WEBHOOK = CREDENTIAL_KIND_TABLE.service.token;

/**
 * How Relo stores credentials (plan 10 M1): only these digests reach the database, and only `credentials/`
 * computes them. Logins and harness credentials use the machine digest (logins also accept the older plain
 * digest); phones and the bootstrap owner key use the plain digest; webhook services their own.
 */
export const plainDigest = (token: string): string => sha256Hex(token);
export const machineDigest = (token: string): string => sha256Hex(`relo:access-token:v1\n${token}`);
export const webhookDigest = (secret: string): string => sha256Hex(`relo:webhook:v1\n${secret}`);

/** The digests a login may be stored under, newest first. */
export const loginDigests = (token: string): string[] => [machineDigest(token),plainDigest(token)];

/** A new machine token (logins, CI tokens, harness credentials): `relo_` and 43 base64url characters. */
export function generateToken(): string {
  return `${MACHINE.lead}${randomBytes(32).toString("base64url")}`;
}

export const WEBHOOK_SECRET_PATTERN = new RegExp(`^${WEBHOOK.lead}[A-Za-z0-9_-]{${WEBHOOK.randomChars}}$`,"u");
export function newWebhookSecret(): string {
  return `${WEBHOOK.lead}${randomBytes(32).toString("base64url")}`;
}

/** The first characters shown in lists; never enough to use. */
export const tokenPrefix = (token: string): string => token.slice(0,MACHINE.shownChars);
export const secretPrefix = (secret: string): string => secret.slice(0,WEBHOOK.shownChars);
