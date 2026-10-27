/** Injected platform pieces. The Windows host backs SecretStore with Credential Manager and passes its own fetch. */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Async string storage. Credential Manager blobs are small (2560 bytes): keep secrets here, long lists in PrefsStore. */
export interface StringStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export type SecretStore = StringStore;
export type PrefsStore = StringStore;

export function memoryStore(): StringStore {
  const map = new Map<string, string>();
  return {
    async get(key) { return map.get(key) ?? null; },
    async set(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
  };
}

export interface PublishablePrekey {
  identityKey: string;
  prekey: { prekeyId: string; publicKey: string; createdAt: string; signature: string };
}

export interface AnswerSignatureRequest {
  interactionId: string;
  notificationId: string;
  deviceId: string;
  /** What the signature covers: "approve", "choose:<optionId>", "answer:<sha256 hex of the text>". */
  value: string;
  respondedAt: string;
  /** Context of the sealed question envelope this device opened; absent for an unsealed question. */
  question?: string;
}

export interface AnswerSignature {
  keyId: string;
  /** base64url, 64 bytes. */
  signature: string;
  /** Present when `question` was given. */
  questionSignature?: string;
}

/**
 * The end-to-end side, owned by packages/owner-crypto. The client never touches key material:
 * it asks for what to publish, hands raw server JSON to be opened, and asks for answer signatures.
 */
export interface OwnerCrypto {
  /** Creates the identity and prekey on first use; never rotates. */
  ensureKeys(): Promise<void>;
  /** The identity key and a prekey signed for `deviceId`; with `rotate` a fresh prekey replaces the current one. */
  publishablePrekey(deviceId: string, options: { rotate: boolean }): Promise<PublishablePrekey>;
  /** Raw server JSON (Now, current inbox page, inbox detail) with sealed text opened in place. Same shape out. */
  openTree(tree: unknown): Promise<unknown>;
  /** Null when this device has no identity key (the answer is then sent unsigned). */
  signAnswer(request: AnswerSignatureRequest): Promise<AnswerSignature | null>;
}

export interface DeviceInfo {
  name: string;
  bundleIdentifier: string;
  appVersion: string;
  appBuild: string;
  osVersion: string;
  model?: string;
}

export const OWNER_CAPABILITIES = ["choice_questions", "owner_overview"] as const;
