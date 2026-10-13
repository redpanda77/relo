import { z } from "zod";

/**
 * End-to-end sealed content (docs/END-TO-END-ENCRYPTION.md, E3). The server checks only the
 * envelope's shape and stores it as opaque JSON: it holds no key that opens it. The shape rules
 * match packages/cli/src/e2ee.mjs `validateEnvelopeShape` and ReloE2EE.validateShape.
 */
const b64u = (length?: number) => z.string().max(140_000).regex(/^[A-Za-z0-9_-]+$/).refine((value) => {
  const bytes = Buffer.from(value,"base64url");
  return bytes.toString("base64url") === value && (length === undefined || bytes.length === length);
},"invalid_encoding");
const binding = z.string().regex(/^[\x21-\x7e]{1,200}$/);

export const sealedEnvelopeSchema = z.object({
  v: z.literal("relo.e2e.v1"),
  kind: z.enum(["notice","question","card","card-update","reply","grouping-key"]),
  context: binding,
  sender: z.string().regex(/^k_[A-Za-z0-9_-]{22}$/),
  recipients: z.array(z.object({
    device: binding,
    prekey: binding,
    enc: b64u(65),
    key: b64u(48),
  }).strict()).min(1).max(16),
  nonce: b64u(12),
  ct: b64u().refine((value) => {
    const length = Buffer.from(value,"base64url").length;
    return length >= 256 + 16 && (length - 16) % 256 === 0;
  },"invalid_ciphertext"),
  sig: b64u(64),
}).strict();

export type SealedEnvelope = z.infer<typeof sealedEnvelopeSchema>;

/** Alert text sealed separately for each phone (fits in a push); the body once for all of them. */
export const sealedNoticeSchema = z.object({
  alerts: z.array(sealedEnvelopeSchema).min(1).max(16),
  content: sealedEnvelopeSchema,
}).strict();

export type SealedNotice = z.infer<typeof sealedNoticeSchema>;

/** What the server shows wherever it would otherwise show text it cannot read. */
export const SEALED_TITLE = "Encrypted notification";
export const SEALED_BODY = "Open Relo on your iPhone to read this.";
export const SEALED_QUESTION_TITLE = "Encrypted question";
export const SEALED_PROMPT = "Open Relo on your iPhone to read this question.";
/** An alert envelope (title + summary) must stay small enough to ride in a 4 KB push. */
const MAX_ALERT_ENVELOPE_BYTES = 1_800;

export type SealedNoticeCheck =
  | { ok: true; deviceIds: string[] }
  | { ok: false; error: "invalid_sealed_content" };

/**
 * Each alert names exactly one phone, no phone twice, the body is sealed to every alerted phone,
 * all envelopes come from one sender, and every envelope is bound to the same request context.
 */
export function checkSealedNotice(sealed: SealedNotice,kind: "notice" | "question" | "card" = "notice"): SealedNoticeCheck {
  const devices = new Set<string>();
  for (const alert of sealed.alerts) {
    if (alert.kind !== kind || alert.recipients.length !== 1) return { ok: false,error: "invalid_sealed_content" };
    if (alert.sender !== sealed.content.sender || alert.context !== sealed.content.context) {
      return { ok: false,error: "invalid_sealed_content" };
    }
    if (Buffer.byteLength(JSON.stringify(alert)) > MAX_ALERT_ENVELOPE_BYTES) return { ok: false,error: "invalid_sealed_content" };
    const device = alert.recipients[0]!.device;
    if (devices.has(device) || !/^dev_[0-9a-f-]{36}$/.test(device)) return { ok: false,error: "invalid_sealed_content" };
    devices.add(device);
  }
  const contentDevices = new Set(sealed.content.recipients.map((recipient) => recipient.device));
  if (sealed.content.kind !== kind || [...devices].some((device) => !contentDevices.has(device))) {
    return { ok: false,error: "invalid_sealed_content" };
  }
  return { ok: true,deviceIds: [...devices] };
}

/** The sealed fields one phone may see: its own alert envelope and the shared body envelope. */
export function sealedForDevice(payload: unknown,devicePublicId: string | undefined): { alert: SealedEnvelope | null; content: SealedEnvelope } | null {
  const parsed = sealedNoticeSchema.safeParse((payload as { sealed?: unknown } | null)?.sealed);
  if (!parsed.success) return null;
  const alert = devicePublicId
    ? parsed.data.alerts.find((envelope) => envelope.recipients[0]?.device === devicePublicId) ?? null
    : null;
  return { alert,content: parsed.data.content };
}

/** Phones that receive their own alert envelope for this payload. */
export function sealedAlertDevices(payload: unknown): string[] {
  const parsed = sealedNoticeSchema.safeParse((payload as { sealed?: unknown } | null)?.sealed);
  return parsed.success ? parsed.data.alerts.map((alert) => alert.recipients[0]!.device) : [];
}

/**
 * A phone's signature over its answer (E4.2), carried inside the answer value so it is stored and
 * returned with it. The CLI, not the server, decides whether it is valid and trusted.
 */
export const answerSignatureSchema = z.object({
  e2eeKeyId: z.string().regex(/^k_[A-Za-z0-9_-]{22}$/),
  e2eeSignedAt: z.iso.datetime(),
  e2eeSignature: b64u(64),
  /** The sealed question's context and a signature binding the answer to it (review H1/H4). */
  e2eeQuestion: binding.optional(),
  e2eeQuestionSignature: b64u(64).optional(),
}).strict();

/** Envelopes without their randomized ECDSA signatures: what an exact retry must repeat. */
export function unsignedSealed(sealed: SealedNotice): unknown {
  const strip = ({ sig: _sig,...rest }: SealedEnvelope) => rest;
  return { alerts: sealed.alerts.map(strip),content: strip(sealed.content) };
}

/**
 * A sealed question request carries no readable title or prompt: refuses one that does, and fills
 * the placeholders the rest of the server shows instead. Returns null for an ordinary request.
 */
export function sealedQuestionRequest(raw: unknown,{ title = true }: { title?: boolean } = {}): { body: Record<string,unknown>; sealed: SealedNotice } | { error: string } | null {
  if (raw === null || typeof raw !== "object" || !("sealed" in raw)) return null;
  const body = raw as Record<string,unknown>;
  if ("prompt" in body || "title" in body || "imageUrl" in body || "destinationUrl" in body) return { error: "sealed_with_plaintext" };
  const parsed = sealedNoticeSchema.safeParse(body.sealed);
  if (!parsed.success) return { error: "invalid_sealed_content" };
  const check = checkSealedNotice(parsed.data,"question");
  if (!check.ok) return { error: check.error };
  return { body: { ...body,...(title ? { title: SEALED_QUESTION_TITLE } : {}),prompt: SEALED_PROMPT },sealed: parsed.data };
}

/** A sealed card's envelopes are kind "card" (E5); Live Activity pushes carry this phone's alert. */
export function checkSealedCard(sealed: SealedNotice | undefined): SealedNoticeCheck | null {
  return sealed ? checkSealedNotice(sealed,"card") : null;
}

/** Hash input for an idempotent card command: envelopes without their randomized signatures. */
export function withUnsignedSealed<T extends { sealed?: SealedNotice | undefined }>(input: T): T | (Omit<T,"sealed"> & { sealed: unknown }) {
  return input.sealed ? { ...input,sealed: unsignedSealed(input.sealed) } : input;
}

/** `{ sealed }` with the alert envelope sealed to this phone, or nothing. */
export function sealedAlertFor(sealed: SealedNotice | undefined,devicePublicId: string): { sealed?: SealedEnvelope } {
  const alert = sealed?.alerts.find((envelope) => envelope.recipients[0]?.device === devicePublicId);
  return alert ? { sealed: alert } : {};
}

/** The card row's stored envelopes, when it is a sealed card. */
export function storedSealedCard(activity: unknown): SealedNotice | undefined {
  const parsed = sealedNoticeSchema.safeParse((activity as { sealed?: unknown } | null)?.sealed);
  return parsed.success && parsed.data.content.kind === "card" ? parsed.data : undefined;
}
