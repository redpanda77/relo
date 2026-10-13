import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

export const MAX_NOTIFICATION_BODY_BYTES = 65_536;
export const MAX_NOTIFICATION_SUMMARY_CHARACTERS = 240;
export const MAX_NOTIFICATION_PREVIEW_BYTES = 720;

export type NotificationBodyFormat = "text" | "markdown";

export type PreparedNotificationContent = {
  body: string;
  bodyFormat: NotificationBodyFormat;
  summary: string;
  preview: string;
  bodyBytes: number;
};

export function notificationContentForPrivacy(
  content: PreparedNotificationContent,
  privacy: "standard" | "private",
): PreparedNotificationContent {
  return privacy === "private"
    ? { ...content,summary: "Private notification",preview: "Open Relo to view" }
    : content;
}

const envelopePrefix = "relo.nc.v1";
const keySalt = Buffer.from("relo:notification-content:key-derivation:v1", "utf8");
const keyInfo = Buffer.from("aes-256-gcm", "utf8");

function normalizedBody(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function scalarLength(value: string): number {
  return Array.from(value).length;
}

function truncateScalars(value: string, maximumScalars: number): string {
  const scalars = Array.from(value);
  if (scalars.length <= maximumScalars) return value;
  return `${scalars.slice(0, Math.max(0, maximumScalars - 1)).join("").trimEnd()}…`;
}

function plainSummarySource(value: string, format: NotificationBodyFormat): string {
  const withoutMarkdown = format === "markdown"
    ? value
      .replace(/```[\s\S]*?```/gu, " ")
      .replace(/`([^`]*)`/gu, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gmu, "")
      .replace(/[*_~]/gu, "")
    : value;
  return withoutMarkdown.replace(/\s+/gu, " ").trim();
}

export function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const suffix = "…";
  const budget = Math.max(0, maximumBytes - Buffer.byteLength(suffix, "utf8"));
  let bytes = 0;
  let output = "";
  for (const scalar of value) {
    const size = Buffer.byteLength(scalar, "utf8");
    if (bytes + size > budget) break;
    output += scalar;
    bytes += size;
  }
  return `${output.trimEnd()}${suffix}`;
}

export function prepareNotificationContent(input: {
  body: string;
  summary?: string | undefined;
  bodyFormat?: NotificationBodyFormat | undefined;
}): PreparedNotificationContent {
  const body = normalizedBody(input.body);
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes < 1 || bodyBytes > MAX_NOTIFICATION_BODY_BYTES) {
    throw new Error("notification_body_bytes_invalid");
  }
  const bodyFormat = input.bodyFormat ?? "text";
  const suppliedSummary = input.summary?.replace(/\s+/gu, " ").trim();
  if (suppliedSummary !== undefined
    && (scalarLength(suppliedSummary) < 1
      || scalarLength(suppliedSummary) > MAX_NOTIFICATION_SUMMARY_CHARACTERS)) {
    throw new Error("notification_summary_invalid");
  }
  const summarySource = suppliedSummary ?? plainSummarySource(body, bodyFormat);
  const summary = truncateScalars(summarySource, MAX_NOTIFICATION_SUMMARY_CHARACTERS);
  if (!summary) throw new Error("notification_summary_invalid");
  return {
    body,
    bodyFormat,
    summary,
    preview: truncateUtf8(summary, MAX_NOTIFICATION_PREVIEW_BYTES),
    bodyBytes,
  };
}

export type NotificationContentCipher = {
  encrypt: (eventId: string, body: string) => string;
  decrypt: (eventId: string, envelope: string) => string;
  /**
   * Keyed digest of a body (HMAC-SHA256 with a key derived from the server secret). A plain
   * SHA-256 would let anyone holding a database dump confirm a guessed body (E1.3).
   */
  digest: (body: string) => string;
};

const digestSalt = Buffer.from("relo:notification-content:digest:v1","utf8");

function aad(eventId: string): Buffer {
  return Buffer.from(`relo:notification-content:aad:v1\n${eventId}`,"utf8");
}

export function createNotificationContentCipher(secret: string): NotificationContentCipher {
  if (secret.length < 32) throw new Error("Notification content encryption secret is required");
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), keySalt, keyInfo, 32));
  const digestKey = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), digestSalt, "hmac-sha256", 32));
  return {
    digest(body) {
      return createHmac("sha256", digestKey).update(body, "utf8").digest("hex");
    },
    encrypt(eventId,body) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(eventId));
      const encrypted = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
      return [envelopePrefix, nonce.toString("base64url"), encrypted.toString("base64url"),
        cipher.getAuthTag().toString("base64url")].join(".");
    },
    decrypt(eventId,envelope) {
      const parts = envelope.split(".");
      if (parts.length !== 6 || parts.slice(0,3).join(".") !== envelopePrefix) {
        throw new Error("Invalid notification content envelope");
      }
      const nonce = Buffer.from(parts[3]!, "base64url");
      const encrypted = Buffer.from(parts[4]!, "base64url");
      const tag = Buffer.from(parts[5]!, "base64url");
      if (nonce.length !== 12 || encrypted.length < 1 || tag.length !== 16) {
        throw new Error("Invalid notification content envelope");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(aad(eventId));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    },
  };
}

export async function persistNotificationContent(
  query: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  cipher: NotificationContentCipher,
  eventId: string,
  content: PreparedNotificationContent,
): Promise<void> {
  await query.query(
    `INSERT INTO notification_contents(
       notification_event_id,summary,body_ciphertext,body_format,body_bytes,content_sha256
     ) VALUES ($1,$2,$3,$4,$5,$6)`,
    [eventId,content.summary,cipher.encrypt(eventId,content.body),content.bodyFormat,
      content.bodyBytes,cipher.digest(content.body)],
  );
}

export function decryptedNotificationBody(
  cipher: NotificationContentCipher,
  row: { id: string; body: string; body_ciphertext?: string | null },
): string {
  return row.body_ciphertext ? cipher.decrypt(row.id,row.body_ciphertext) : row.body;
}
