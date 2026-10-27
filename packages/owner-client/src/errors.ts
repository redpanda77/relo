export type OwnerErrorKind =
  | "unauthorized" // 401/403 on a device credential: sign in again
  | "forbidden"
  | "unreachable"
  | "unavailable"
  | "invalid_response"
  | "invalid_request"
  | "conflict"
  | "rate_limited"
  | "account_disabled"
  | "invalid_grant"
  | "rejected" // an answer the server refused: see `code`
  | "callback_malformed"
  | "state_mismatch";

export class OwnerClientError extends Error {
  constructor(
    readonly kind: OwnerErrorKind,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(`${kind}${status ? ` (${status})` : ""}${code ? `: ${code}` : ""}`);
    this.name = "OwnerClientError";
  }
}

export const isUnauthorized = (error: unknown): boolean =>
  error instanceof OwnerClientError && error.kind === "unauthorized";
